// A stand-in for ocr/worker.py, so unit tests never start Python. Speaks the
// same protocol (JSON lines). Usage: node fake-ocr-worker.mjs <mode> [state file]
//   ok        answers every job with lines describing the job
//   slow      never answers a job
//   crash     exits on the first job, every time
//   crashonce exits on the first job unless the state file exists (then ok)
//   garbage   answers a job with text that is not JSON
//   huge      answers a job with a line over the size cap
//   badshape  answers a job with JSON of the wrong shape
//   error     answers every job with an error
//   noready   never says it is ready
//   sideways  answers with tall boxes that read upside down, or wide ones for a wide picture
//   okthenerror  answers the first job like ok, every later job with an error
//   okthencrash  answers the first job like ok, exits on the second
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [mode = "ok", stateFile] = process.argv.slice(2);
const jobDir = process.env.CRD_OCR_JOB_DIR;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/** Width and height of a PNG from its header. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

if (mode !== "noready") send({ ready: true });

const rl = readline.createInterface({ input: process.stdin });
let jobs = 0;
rl.on("line", (raw) => {
  const job = JSON.parse(raw);
  jobs++;
  if (mode === "okthenerror" && jobs > 1) return send({ id: job.id, error: "bad_image" });
  if (mode === "okthencrash" && jobs > 1) process.exit(3);
  if (mode === "slow" || mode === "noready") return;
  if (mode === "crash") process.exit(3);
  if (mode === "crashonce" && !fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, "crashed");
    process.exit(3);
  }
  if (mode === "garbage") return process.stdout.write("this is not json\n");
  if (mode === "huge") return process.stdout.write(`{"id":${job.id},"pad":"${"x".repeat(3 * 1024 * 1024)}"}\n`);
  if (mode === "badshape") return send({ id: job.id, width: 10, height: 10, lines: [{ text: 5 }] });
  if (mode === "error") return send({ id: job.id, error: "read_failed" });
  const inDir = path.dirname(job.image) === jobDir;
  const { width, height } = pngSize(job.image);
  const mode600 = (fs.statSync(job.image).mode & 0o777).toString(8);
  const dirMode = (fs.statSync(jobDir).mode & 0o777).toString(8);
  if (mode === "sideways" && height > width) {
    // Text running up the picture: tall boxes, read upside down after the worker's quarter turn.
    return send({ id: job.id, width, height, lines: [
      { text: "BILL RIPKEN", score: 0.9, box: [[10, 100], [40, 100], [40, 400], [10, 400]], turned: true },
      { text: "1989 FLEER CORP", score: 0.9, box: [[60, 100], [80, 100], [80, 500], [60, 500]], turned: true },
    ] });
  }
  send({ id: job.id, width, height, lines: [
    { text: `size ${width}x${height}`, score: 0.95, box: [[0, 0], [width / 2, 0], [width / 2, height / 4], [0, height / 4]], turned: false },
    { text: `in job folder ${inDir} file ${mode600} folder ${dirMode}`, score: 0.9, box: [[0, height / 2], [width, height / 2], [width, height], [0, height]], turned: false },
    { text: `secret ${process.env.SESSION_SECRET ? "seen" : "absent"} threads ${process.env.CRD_OCR_THREADS} telemetry ${process.env.ORT_DISABLE_TELEMETRY === "1" ? "off" : "on"}`, score: 0.8, box: [[0, height / 4], [width, height / 4], [width, height / 2], [0, height / 2]], turned: false },
    { text: "x", score: 0.99, box: [[0, 0], [5, 0], [5, 5], [0, 5]], turned: false },
    { text: "LOW SCORE", score: 0.1, box: [[0, 0], [5, 0], [5, 5], [0, 5]], turned: false },
  ] });
});
