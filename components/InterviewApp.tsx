"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { GoogleGenAI, Modality, Session, LiveServerMessage } from "@google/genai";
import ReactMarkdown from "react-markdown";

// ── Constants ───────────────────────────────────────────────────────────────
const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const SAMPLE_RATE = 16000;

// ── Types ───────────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════
export default function InterviewApp() {
  // ── Audio helpers ─────────────────────────────────────────────────────────
  const stopAudio = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  // ── State ─────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Accumulator refs for streaming partial text
  const currentAssistantText = useRef("");
  const currentAssistantId = useRef<string | null>(null);
  const currentUserText = useRef("");
  const currentUserId = useRef<string | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const sessionRef = useRef<Session | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // ── Connect to Gemini Live API ────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (sessionRef.current) return;
    setIsConnecting(true);
    setError(null);

    try {
      // 1. Get API key from server
      const res = await fetch("/api/key");
      const data = await res.json();
      if (!res.ok || !data.key) throw new Error(data.error || "No API key");

      // 2. Open WebSocket via SDK
      
      const ai = new GoogleGenAI({ apiKey: data.key });
      
      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [
              {
                text: "Answer the questions in short.",
              },
            ],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: true,
            }
          }
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
          },
          onmessage: (msg: LiveServerMessage) => {
            try {
              // Setup complete
              if (msg.setupComplete) {
                return;
              }

              // Server content
              if (msg.serverContent) {
                const sc = msg.serverContent;

                // Input transcription (what the user said)
                if (sc.inputTranscription && sc.inputTranscription.text) {
                  const text = sc.inputTranscription.text;
                  if (!currentUserId.current) {
                    currentUserId.current = uid();
                    currentUserText.current = "";
                    setMessages((prev) => [
                      ...prev,
                      { id: currentUserId.current!, role: "user", text: "" },
                    ]);
                  }
                  currentUserText.current += text;
                  const id = currentUserId.current;
                  const fullText = currentUserText.current;
                  setMessages((prev) =>
                    prev.map((m) => (m.id === id ? { ...m, text: fullText } : m))
                  );
                }

                // Model turn (assistant response)
                if (sc.modelTurn && sc.modelTurn.parts) {
                  // When model starts responding, finalize user message
                  if (currentUserId.current) {
                    currentUserId.current = null;
                    currentUserText.current = "";
                  }

                  for (const part of sc.modelTurn.parts) {
                    // We requested AUDIO, but we might receive text alongside audio if transcription is enabled
                    // Or we might just ignore the audio chunks because we don't play them.
                    const newText = part.text;
                    if (newText) {
                      if (!currentAssistantId.current) {
                        currentAssistantId.current = uid();
                        currentAssistantText.current = "";
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: currentAssistantId.current!,
                            role: "assistant",
                            text: "",
                          },
                        ]);
                      }
                      currentAssistantText.current += newText;
                      const id = currentAssistantId.current;
                      const fullText = currentAssistantText.current;
                      setMessages((prev) =>
                        prev.map((m) =>
                          m.id === id ? { ...m, text: fullText } : m
                        )
                      );
                    }
                    
                    // Note: If we receive audio `inlineData`, we just ignore it so it stays muted.
                  }
                }

                // Turn complete — reset accumulators
                if (sc.turnComplete) {
                  currentAssistantId.current = null;
                  currentAssistantText.current = "";
                  currentUserId.current = null;
                  currentUserText.current = "";
                }

                // Interrupted
                if (sc.interrupted) {
                  currentAssistantId.current = null;
                  currentAssistantText.current = "";
                }
              }
            } catch {
              // ignore parse errors
            }
          },
          onerror: (e: ErrorEvent) => {
            setError(`WebSocket error: ${e.message || "Unknown error"}`);
            setIsConnecting(false);
          },
          onclose: () => {
            setIsConnected(false);
            setIsConnecting(false);
            setIsRecording(false);
            sessionRef.current = null;
            stopAudio();
          },
        },
      });

      sessionRef.current = session;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setIsConnecting(false);
    }
  }, [stopAudio]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    stopAudio();
    if (sessionRef.current) {
      // NOTE: For the genai SDK, close might not be strongly typed on the interface
      // However the underlying connection supports closing. We force cast to close.
      const s = sessionRef.current as unknown as { close?: () => void };
      if (typeof s.close === "function") s.close();
    }
    sessionRef.current = null;
    setIsConnected(false);
    setIsRecording(false);
  }, [stopAudio]);

  // ── Start recording ───────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (!sessionRef.current) {
      setError("Not connected to Gemini");
      return;
    }

    try {
      // Request microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Create AudioContext at 16kHz
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // Load audio worklet
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "audio-processor");
      workletNodeRef.current = workletNode;

      // Handle audio data from worklet
      workletNode.port.onmessage = (event) => {
        if (event.data.type === "audio" && sessionRef.current) {
          const base64Audio = arrayBufferToBase64(event.data.data);
          sessionRef.current.sendRealtimeInput({
            audio: {
              data: base64Audio,
              mimeType: `audio/pcm;rate=${SAMPLE_RATE}`,
            }
          });
        }
      };

      source.connect(workletNode);
      // Connect to destination to keep the pipeline alive (output is silent)
      workletNode.connect(audioContext.destination);

      // Signal the start of user voice activity
      sessionRef.current.sendRealtimeInput({ activityStart: {} });

      setIsRecording(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError("Microphone access denied: " + message);
    }
  }, []);

  // ── Stop recording ────────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    // Send voice activity end signal instead of audio stream end
    if (sessionRef.current) {
      try {
        sessionRef.current.sendRealtimeInput({ activityEnd: {} });
      } catch (e) {
        console.error("Failed to send activity end:", e);
      }
    }
    stopAudio();
    setIsRecording(false);
  }, [stopAudio]);

  // ── Clear conversation ────────────────────────────────────────────────────
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAudio();
      if (sessionRef.current && typeof sessionRef.current.close === "function") {
        sessionRef.current.close();
      }
    };
  }, [stopAudio]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-[100dvh] bg-slate-950 text-slate-50 font-sans selection:bg-indigo-500/30 overflow-hidden relative w-full">
      {/* Background ambient light */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-purple-600/20 blur-[120px] rounded-full pointer-events-none" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="shrink-0 w-full relative z-10 flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-8 py-3 sm:py-5 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-xl">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-white font-black text-xs sm:text-sm shadow-lg shadow-indigo-500/25 ring-1 ring-white/10 shrink-0">
            AI
          </div>
          <div className="flex-col min-w-0">
            <h1 className="text-sm sm:text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400 truncate">
              <span className="hidden sm:inline">Interview </span>Assistant
            </h1>
            <p className="hidden sm:block text-xs font-medium text-slate-400 truncate">
              Real-time Audio Intelligence
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          {/* Connection indicator */}
          <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-full bg-slate-900/50 border border-slate-800/80 shadow-inner">
            <div className="relative flex h-2 sm:h-2.5 w-2 sm:w-2.5 shrink-0">
              {isConnecting && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
              )}
              <span
                className={`relative inline-flex rounded-full h-2 sm:h-2.5 w-2 sm:w-2.5 ${
                  isConnected
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                    : isConnecting
                    ? "bg-yellow-400"
                    : "bg-slate-600"
                }`}
              ></span>
            </div>
            <span className="text-[10px] sm:text-xs font-medium text-slate-300 tracking-wide uppercase">
              <span className="hidden sm:inline">
                {isConnected ? "Connected" : isConnecting ? "Connecting…" : "Disconnected"}
              </span>
              <span className="sm:hidden">
                {isConnected ? "On" : isConnecting ? "..." : "Off"}
              </span>
            </span>
          </div>

          {/* Connect / Disconnect button */}
          {!isConnected ? (
            <button
               onClick={connect}
              disabled={isConnecting}
              className="px-3 sm:px-5 py-1.5 sm:py-2.5 rounded-lg sm:rounded-xl bg-white text-slate-950 hover:bg-slate-100 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed text-xs sm:text-sm font-semibold transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] shrink-0"
            >
              <span className="hidden sm:inline">{isConnecting ? "Connecting…" : "Connect API"}</span>
              <span className="sm:hidden">{isConnecting ? "Wait…" : "Connect"}</span>
            </button>
          ) : (
            <button
               onClick={disconnect}
              className="px-3 sm:px-5 py-1.5 sm:py-2.5 rounded-lg sm:rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700/50 hover:border-slate-600 active:scale-[0.98] text-xs sm:text-sm font-semibold transition-all backdrop-blur-md shrink-0"
            >
              <span className="hidden sm:inline">Disconnect</span>
              <span className="sm:hidden">Stop</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {error && (
        <div className="relative z-20 mx-6 mt-4 p-[1px] rounded-xl bg-gradient-to-r from-red-500/50 to-orange-500/50 shadow-lg shadow-red-900/20 animate-in fade-in slide-in-from-top-4">
          <div className="px-4 py-3 rounded-[11px] bg-slate-950/90 backdrop-blur-xl flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm text-red-200">
               <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
               {error}
            </div>
            <button
               onClick={() => setError(null)}
              className="ml-4 p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Messages ────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8 space-y-4 sm:space-y-6 scroll-smooth pb-32 sm:pb-32">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4 animate-in fade-in duration-1000">
             <div className="p-4 sm:p-6 rounded-[20px] sm:rounded-3xl bg-slate-900/40 border border-slate-800/50 shadow-2xl backdrop-blur-sm mx-4 sm:mx-0">
                <svg
                  className="w-10 h-10 sm:w-12 sm:h-12 text-slate-600 mx-auto mb-3 sm:mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <p className="text-sm font-medium text-center text-slate-400 max-w-[250px] leading-relaxed">
                  Ready when you are. Connect and press the microphone to begin the interview.
                </p>
             </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex w-full animate-in slide-in-from-bottom-2 fade-in duration-300 ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
             <div className={`flex flex-col gap-1 sm:gap-1.5 max-w-[90%] sm:max-w-[75%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
               {/* Label */}
               <div className="flex items-center gap-2 px-1">
                 <span className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-widest ${msg.role === "user" ? "text-indigo-400" : "text-emerald-400"}`}>
                   {msg.role === "user" ? "Interviewer" : "AI Assistant"}
                 </span>
               </div>
               
               {/* Message Bubble */}
               <div
                  className={`relative p-[1px] rounded-[20px] md:rounded-3xl shadow-lg ${
                    msg.role === "user"
                      ? "bg-gradient-to-br from-indigo-500 to-purple-600 rounded-br-sm"
                      : "bg-slate-800 rounded-bl-sm"
                  }`}
               >
                 <div
                    className={`px-4 sm:px-5 py-3 sm:py-4 rounded-[19px] md:rounded-[23px] text-[14px] sm:text-[15px] leading-relaxed whitespace-pre-wrap ${
                      msg.role === "user"
                        ? "bg-gradient-to-br from-indigo-500 to-purple-600 text-white"
                        : "bg-slate-900/90 backdrop-blur-xl text-slate-200"
                    } ${
                      msg.role === "user" ? "rounded-br-[2px]" : "rounded-bl-[2px]"
                    }`}
                 >
                    {msg.text ? (
                      <div className="[&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-bold [&_em]:italic [&_code]:bg-slate-800/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_ul]:list-none [&_ul]:p-0 [&_ul]:space-y-2 [&_li]:relative [&_li]:pl-4 [&_li]:before:content-['•'] [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:text-emerald-400">
                        {msg.role === "assistant" ? (
                          <ul className="list-disc pl-5 space-y-2">
                            {msg.text.split(/(?<=[.?!])\s+(?=[A-Z])/).filter(sentence => sentence.trim().length > 0).map((sentence, idx) => (
                              <li key={idx}>
                                <ReactMarkdown>{sentence.trim()}</ReactMarkdown>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <ReactMarkdown>
                            {msg.text}
                          </ReactMarkdown>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 h-6 px-2 opacity-50">
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
                      </div>
                    )}
                 </div>
               </div>
             </div>
          </div>
        ))}
        <div ref={messagesEndRef} className="h-4" />
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-20 pb-6 sm:pb-8 pt-20 sm:pt-24 px-4 sm:px-6 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent pointer-events-none">
        <div className="max-w-md mx-auto pointer-events-auto">
          <div className="flex flex-col items-center gap-3 sm:gap-4 relative">
            
            {/* Record button */}
            <button
               onClick={isRecording ? stopRecording : startRecording}
              disabled={!isConnected}
              className={`group relative flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 rounded-full transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed ${
                isRecording
                  ? "bg-red-500 scale-110 shadow-[0_0_30px_rgba(239,68,68,0.4)]"
                  : "bg-white hover:scale-105 shadow-[0_10px_30px_rgba(0,0,0,0.3)] hover:shadow-[0_0_30px_rgba(255,255,255,0.2)]"
              }`}
              title={isRecording ? "Stop recording" : "Start recording"}
            >
              {isRecording ? (
                <>
                  <span className="absolute inset-0 rounded-full bg-red-400 animate-ping opacity-30" />
                  <svg className="w-6 h-6 text-white relative z-10" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                </>
              ) : (
                <svg
                  className="w-7 h-7 text-indigo-600 group-hover:text-indigo-500 transition-colors"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
            
            {/* Auxiliary actions */}
            <div className="flex items-center gap-4 sm:gap-6 mt-1 sm:mt-0">
               <button
                 onClick={clearMessages}
                 disabled={messages.length === 0}
                 className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-slate-900/80 border border-slate-800 hover:bg-slate-800 text-[10px] sm:text-xs font-medium text-slate-400 hover:text-slate-200 transition-all disabled:opacity-0 translate-y-0 disabled:translate-y-4 backdrop-blur-md"
               >
                 <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                   <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                 </svg>
                 Clear History
               </button>
            </div>

            {isRecording && (
              <p className="absolute -top-10 text-[10px] font-bold tracking-widest uppercase text-red-400 animate-pulse bg-slate-950/60 px-3 py-1 rounded-full backdrop-blur-sm">
                Listening...
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
