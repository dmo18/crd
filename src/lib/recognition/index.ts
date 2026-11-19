import { env, recognitionMode } from "@/lib/env";
import { AnthropicRecognizer } from "./anthropic";
import { FreeRecognizer } from "@/lib/free/recognizer";
import { getCatalog } from "@/lib/catalog/provider";
import { SampleRecognizer } from "./sample";
import { RecognitionError, type Recognizer } from "./types";

/** The recognizer to use right now. Free reading unless set otherwise. */
export function getRecognizer(): Recognizer {
  const mode = recognitionMode();
  if (mode === "sample") return new SampleRecognizer();
  // Free reading looks each card up in the catalog afterwards (switched off on Connections: no calls).
  if (mode === "free") return new FreeRecognizer({ catalog: getCatalog() });
  if (!env().ANTHROPIC_API_KEY) {
    throw new RecognitionError("Paid reading is not set up yet. Add the API key in settings.");
  }
  return new AnthropicRecognizer();
}
