import assert from "node:assert/strict";
import { parseGoogleSheetLink } from "./google-sheet-url.mjs";

const queryAndHash = parseGoogleSheetLink(
  "https://docs.google.com/spreadsheets/d/abc123/edit?gid=94813446#gid=94813446"
);
assert.equal(queryAndHash.spreadsheetId, "abc123");
assert.equal(queryAndHash.gid, "94813446");

const hashOnly = parseGoogleSheetLink(
  "[시트](https://docs.google.com/spreadsheets/d/abc123/edit#gid=0)"
);
assert.equal(hashOnly.gid, "0");
assert.equal(
  hashOnly.canonicalUrl,
  "https://docs.google.com/spreadsheets/d/abc123/edit?gid=0#gid=0"
);

assert.throws(
  () =>
    parseGoogleSheetLink(
      "https://docs.google.com/spreadsheets/d/abc123/edit"
    ),
  /gid/
);
assert.throws(() => parseGoogleSheetLink("https://example.com/test"), /Google Sheets/);

console.log("google sheet url: ok");
