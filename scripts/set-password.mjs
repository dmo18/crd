// Turns a password into the OWNER_PASSWORD_HASH_B64 setting.
// Usage: npm run set-password   (you are asked for the password, it is not shown)
import readline from "node:readline";
import bcrypt from "bcryptjs";

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
  });
}

const password = process.env.CRD_PASSWORD ?? (await ask("New owner password (12+ characters): "));
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}
const hash = bcrypt.hashSync(password, 12);
console.log("Add this line to .env.local (or your host's settings):\n");
console.log(`OWNER_PASSWORD_HASH_B64=${Buffer.from(hash).toString("base64")}`);
