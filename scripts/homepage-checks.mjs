/**
 * Locks the public homepage and the GeoDataTrack launch path.
 * No network. The framed handshake block must match the pre-homepage app.
 *
 *   node scripts/homepage-checks.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const index = read("index.html");
const about = read("about/index.html");
const rootToml = read("netlify.toml");
const publicToml = read("public/netlify.toml");

const start = index.indexOf("var _booted=false;");
const end = index.indexOf("})();\n</script></body></html>");
assert.ok(start > 0 && end > start, "handshake block missing");
const handshake = index.slice(start, end);
assert.equal(
  createHash("sha256").update(handshake).digest("hex"),
  "a35ce2b6e4c135e28baf47c0cef1b1fe817a4fe695e4567127d5eeb284232cc5",
  "framed launch / host:init path changed",
);
assert.match(index, /<title>EIA<\/title>/);
assert.match(index, /postMessage\(\{type:'app:ready',source:'eia-gdt'\}/);
assert.match(index, /postMessage\(\{type:'app:requestInit',source:'eia-gdt'\}/);
assert.match(index, /originIsGdt/);
assert.equal(index.includes("X-Frame-Options"), false);
assert.equal(index.includes("frame-ancestors"), false);

const redirectAt = index.indexOf("location.replace('/about/')");
const framedReturn = index.indexOf("if(framed)return;");
assert.ok(framedReturn > 0 && redirectAt > framedReturn, "unframed redirect must return first when framed");
assert.equal((index.match(/type:'app:ready'/g) || []).length, 1);
assert.equal((index.match(/type:'app:requestInit'/g) || []).length, 1);
assert.match(index, /widget=1/);
assert.match(index, /<noscript>[\s\S]*href="\/about\/"/);

function assertAboutLinks(html, label) {
  const tags = [...html.matchAll(/<a class="eia-about"[^>]*>[\s\S]*?<\/a>/g)];
  assert.ok(tags.length >= 2, `${label} needs About in the bar and again lower down`);
  for (const tag of tags) {
    assert.match(tag[0], /href="\/about\/"/, label);
    assert.match(tag[0], /target="_blank"/, label);
    assert.match(tag[0], /rel="noopener"/, label);
    assert.match(tag[0], />About</, label);
  }
  const relaxAt = html.indexOf("removeAttribute('target')");
  const framedAt = html.indexOf("if(framed)return;");
  assert.ok(framedAt > 0 && relaxAt > framedAt, `${label} must keep new-tab About links when framed`);
}
assertAboutLinks(index, "index.html");
assertAboutLinks(read("public/chat.html"), "public/chat.html");
assertAboutLinks(read("compare.html"), "compare.html");

assert.equal(
  /X-Frame-Options|frame-ancestors|\[\[headers\]\]|\[\[redirects\]\]|publish\s*=/.test(rootToml),
  false,
  "root netlify.toml must not gain headers, redirects, or a publish directory",
);
assert.match(publicToml, /X-Frame-Options = "DENY"/);
assert.match(publicToml, /publish = "public"/);

assert.equal(/<script\b/i.test(about), false, "homepage must not run script");
assert.equal(/<iframe\b/i.test(about), false);
assert.equal(/fetch\(|\/api\/|localStorage|document\.cookie/i.test(about), false);
assert.equal(/aya/i.test(about), false);
assert.match(about, /og:title/);
assert.match(about, /og:image/);
assert.match(about, /rel="icon"/);
assert.match(about, /rel="canonical" href="https:\/\/hm-eia\.net\/about\/"/);
assert.equal((about.match(/p-198399388/g) || []).length, 1);
assert.match(about, /Ecologically Intelligent Agent/);
assert.match(about, /<h1>EIA, the Ecologically Intelligent Agent<\/h1>\s*<p class="tagline">Soil is the soul of our planet\.<\/p>/);
const desc = about.match(/<meta name="description" content="([^"]+)"/)[1];
const ogDesc = about.match(/<meta property="og:description" content="([^"]+)"/)[1];
assert.equal(desc.startsWith("Soil is the soul of our planet."), true);
assert.equal(ogDesc.startsWith("Soil is the soul of our planet."), true);
assert.ok(desc.length <= 160, `meta description is ${desc.length} chars`);
assert.ok(ogDesc.length <= 160, `og:description is ${ogDesc.length} chars`);
assert.match(about, /Theia/);
assert.match(about, /The land is the court/);
assert.match(about, /EIA draft – generated 23 Oct 2026, not yet reviewed/);
assert.match(about, /href="https:\/\/app\.geodatatrack\.com"/);
assert.match(about, /href="\/public\/chat\.html"/);
assert.match(about, /href="https:\/\/ecoregion\.net\/eia\/"/);
assert.match(about, /Placeholder mark/);
assert.match(about, /No approved screenshot/);

const scoreRe = /\b(?:scores?|scored|grades?|graded)\b/gi;
const scoreAllowed = [
  "never grades land and never produces scores",
  "no score enters the plan",
  "does not turn a finding into a grade",
];
for (const match of about.matchAll(scoreRe)) {
  const from = Math.max(0, match.index - 80);
  const window = about.slice(from, match.index + match[0].length + 40).toLowerCase();
  assert.equal(
    scoreAllowed.some((phrase) => window.includes(phrase)),
    true,
    `unexpected score/grade wording: ${window}`,
  );
}

const urls = [
  ...[...about.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ...[...about.matchAll(/\bcontent="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
];
const allowedExternal = [
  "https://app.geodatatrack.com",
  "https://ecoregion.net/eia/",
  "https://substack.com/home/post/p-198399388",
  "https://holistic-financial-planning.netlify.app",
  "https://hm-eia.net/about/",
  "https://hm-eia.net/about/og.png",
];
for (const url of urls) {
  if (url.startsWith("/") || url.startsWith("#") || url.startsWith("mailto:")) continue;
  assert.equal(allowedExternal.includes(url), true, `unexpected homepage URL: ${url}`);
  assert.equal(url === "https://hm-eia.net" || url === "https://hm-eia.net/" || url.endsWith("/index.html"), false);
}
assert.equal(urls.includes("/"), false, "homepage must not link to the bare app root");
assert.equal(urls.includes("/index.html"), false);
assert.equal(urls.includes("/chat.html"), false);

const svg = read("favicon.svg");
assert.match(svg, /#0f6e56/);
assert.equal(/<script\b/i.test(svg), false);

console.log("homepage checks passed");
