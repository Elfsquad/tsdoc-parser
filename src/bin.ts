#!/usr/bin/env node
import * as fs from "fs";
import { parseTypeScriptFile } from "./parser";

if (process.argv.length < 4) {
  console.error('Usage: tsdoc-parser <inputFile> <outputFile> [className]');
  process.exit(1);
}

const [,, inputFile, outputFile, className] = process.argv;
if (!fs.existsSync(inputFile)) {
  console.error(`File ${inputFile} does not exist`);
  process.exit(1);
}

const tsDocComments = parseTypeScriptFile(inputFile, className);
fs.writeFileSync(outputFile, JSON.stringify(tsDocComments, null, 2));

