// Phrasings the sentence-regex extractor does not slot correctly.
// Used by scripts/eval-extract.js

module.exports = [
  {
    id: "home-is",
    content: "My home is Lisbon.",
    expect: { type: "static", slot: "location", valueRe: /lisbon/i },
  },
  {
    id: "employed-by",
    content: "Employed by Acme Corp.",
    expect: { type: "static", slot: "employer", valueRe: /acme/i },
  },
  {
    id: "office-at",
    content: "Office is at Stripe.",
    expect: { type: "static", slot: "employer", valueRe: /stripe/i },
  },
  {
    id: "fr-live",
    content: "Je vis à Paris.",
    expect: { type: "static", slot: "location", valueRe: /paris/i },
  },
  {
    id: "es-live",
    content: "Vivo en Madrid.",
    expect: { type: "static", slot: "location", valueRe: /madrid/i },
  },
  {
    id: "de-live",
    content: "Ich wohne in Berlin.",
    expect: { type: "static", slot: "location", valueRe: /berlin/i },
  },
  {
    id: "relocated",
    content: "Relocated to Austin last year.",
    expect: { type: "static", slot: "location", valueRe: /austin/i },
  },
  {
    id: "staff-cern",
    content: "Staff engineer at CERN.",
    expect: { type: "static", valueRe: /cern/i },
  },
  {
    id: "neovim",
    content: "Daily driver is Neovim.",
    expect: { type: "static", valueRe: /neovim/i },
  },
  {
    id: "allergy",
    content: "Allergic to peanuts.",
    expect: { type: "static", valueRe: /peanut/i },
  },
  {
    id: "pet",
    content: "Dog named Mochi.",
    expect: { type: "static", valueRe: /mochi/i },
  },
  {
    id: "home-city",
    content: "Home city: Oslo.",
    expect: { type: "static", slot: "location", valueRe: /oslo/i },
  },
  {
    id: "role-colon",
    content: "Role: product designer.",
    expect: { type: "static", valueRe: /designer/i },
  },
  {
    id: "helix",
    content: "Editor of choice: Helix.",
    expect: { type: "static", valueRe: /helix/i },
  },
  {
    id: "daughter",
    content: "Daughter named Asha.",
    expect: { type: "static", valueRe: /asha/i },
  },
  {
    id: "timezone",
    content: "Timezone is Europe/Lisbon.",
    expect: { type: "static", valueRe: /europe\/lisbon|timezone/i },
  },
  {
    id: "based-out",
    content: "Based out of Tokyo these days.",
    expect: { types: ["static", "dynamic"], slot: "location", valueRe: /tokyo/i },
  },
  {
    id: "ships-friday",
    content: "Shipping the billing rewrite this Friday.",
    expect: { type: "dynamic", valueRe: /billing|rewrite|friday/i },
  },
  {
    id: "dark-mode",
    content: "Prefer dark mode everywhere.",
    expect: { type: "static", valueRe: /dark/i },
  },
  {
    id: "researcher-not-lawyer",
    content: "Working as a researcher, not a lawyer.",
    expect: { type: "static", valueRe: /researcher/i },
  },
  {
    id: "retract-berlin",
    content:
      "I live in Berlin. Actually, ignore what I said about Berlin — I moved to Lisbon.",
    expect: { type: "static", slot: "location", valueRe: /lisbon/i },
    reject: { slot: "location", valueRe: /berlin/i },
  },
];
