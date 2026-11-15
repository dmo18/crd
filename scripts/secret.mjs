// Prints a random SESSION_SECRET.
import crypto from "node:crypto";
console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString("base64url")}`);
