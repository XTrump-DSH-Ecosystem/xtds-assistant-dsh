import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [filePath, stopPath, resultPath] = process.argv.slice(2);
let reads = 0;
let missing = 0;
let parseErrors = 0;
let shapeErrors = 0;

const delay = () => new Promise((resolve) => setTimeout(resolve, 1));

while (!existsSync(stopPath)) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    reads += 1;
    if (value === null
      || typeof value !== "object"
      || !Number.isInteger(value.seq)
      || typeof value.payload !== "string") {
      shapeErrors += 1;
    }
  } catch (error) {
    if (error.code === "ENOENT") missing += 1;
    else parseErrors += 1;
  }
  await delay();
}

writeFileSync(resultPath, JSON.stringify({ reads, missing, parseErrors, shapeErrors }, null, 2));
