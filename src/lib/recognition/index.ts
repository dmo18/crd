import { env, recognitionMode } from "@/lib/env";
import { AnthropicRecognizer } from "./anthropic";
import { FreeRecognizer } from "@/lib/free/recognizer";
import { SampleRecognizer } from "./sample";
import { RecognitionError, type Recognizer } from "./types";

/** The recognizer to use right now. Free reading unless set otherwise. */
export function getRecognizer(): Recognizer {
  const mode = recognitionMode();
  if (mode === "sample") return new SampleRecognizer();
  if (mode === "free") return new FreeRecognizer();
  if (!env().ANTHROPIC_API_KEY) {
    throw new RecognitionError("AI recognition is not set up yet. Add the API key in settings.");
  }
  return new AnthropicRecognizer();
}
