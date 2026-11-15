import { env, recognitionMode } from "@/lib/env";
import { AnthropicRecognizer } from "./anthropic";
import { SampleRecognizer } from "./sample";
import { RecognitionError, type Recognizer } from "./types";

/** The recognizer to use right now: the real AI one or the free sample one. */
export function getRecognizer(): Recognizer {
  if (recognitionMode() === "sample") return new SampleRecognizer();
  if (!env().ANTHROPIC_API_KEY) {
    throw new RecognitionError("AI recognition is not set up yet. Add the API key in settings.");
  }
  return new AnthropicRecognizer();
}
