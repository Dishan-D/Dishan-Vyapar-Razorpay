import { createReadStream } from "node:fs";
import OpenAI from "openai";
import { activeProvider, GROQ_BASE_URL } from "../llm/provider.js";

export const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";

export interface Transcription {
  text: string;
  model: string;
  /** What the model thought it was hearing, when it says. */
  language?: string;
}

/**
 * A real voice note, turned into words.
 *
 * Until now the project asked for voice notes "already transcribed", which was
 * honest but hollow — a shopkeeper does not have a transcript, they have their
 * voice. Groq hosts Whisper, so the recording itself can be the input.
 *
 * No language is forced. These merchants speak Hinglish and Tamil-English, and
 * pinning the model to "en" makes it translate rather than transcribe, which
 * loses exactly the words the extraction later depends on ("ek hi piece bacha
 * hai", "pathinanju packet").
 */
export async function transcribe(filePath: string): Promise<Transcription> {
  if (activeProvider() !== "groq") {
    throw new Error("Transcription needs GROQ_API_KEY — Whisper is served there");
  }

  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  const result = await groq.audio.transcriptions.create({
    file: createReadStream(filePath) as unknown as File,
    model: TRANSCRIBE_MODEL,
    response_format: "verbose_json",
  });

  const text = typeof result === "string" ? result : (result.text ?? "");
  const language = typeof result === "string" ? undefined : (result as { language?: string }).language;

  return { text: text.trim(), model: TRANSCRIBE_MODEL, ...(language ? { language } : {}) };
}

/** Formats a browser MediaRecorder produces, and what to call the file. */
export const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-m4a": ".m4a",
};
