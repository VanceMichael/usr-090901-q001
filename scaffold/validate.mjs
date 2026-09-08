import { readFileSync } from "node:fs";
const read = (path) => JSON.parse(readFileSync(`/workspace/${path}`, "utf8"));
const contract = read("contracts/request.schema.json");
const samples = read("fixtures/sample-requests.json");
const rules = read("fixtures/rules.json");
if (contract.type !== "object" || !Array.isArray(samples) || samples.length === 0 || !rules.version) throw new Error("invalid scaffold inputs");
console.log("scaffold inputs valid");
