const { test } = require("node:test");
const assert = require("node:assert");
const { slotsForQuery } = require("../lib/query-intent");

// The intent prior is intentionally conservative: it only needs to recognize
// common ways of asking about a stored slot. These tests pin both the useful
// mappings and the phrases that must NOT trigger an employer/location boost.

test("maps common slot questions to their extracted slot", () => {
  const cases = [
    ["Where does the user work?", "employer"],
    ["Where does the user work now?", "employer"],
    ["Which company employs the user?", "employer"],
    ["Who is the user's employer?", "employer"],
    ["Who does the user work for?", "employer"],
    ["What is the user's job title?", "role"],
    ["What position does the user hold?", "role"],
    ["What kind of engineer is the user?", "role"],
    ["Where is the user based?", "location"],
    ["What city is the user located in?", "location"],
    ["Where does the user live?", "location"],
    ["Which city does the user call home?", "location"],
    ["What text editor does the user prefer?", "editor"],
    ["Which IDE does the user use?", "editor"],
    ["Which programming language does the user like best?", "language_pref"],
    ["What is the user's preferred programming language?", "language_pref"],
  ];
  for (const [query, slot] of cases) {
    assert.ok(slotsForQuery(query).has(slot), `${JSON.stringify(query)} should map to ${slot}`);
  }
});

test("does not treat the current task or unrelated near-misses as slot intent", () => {
  assert.equal(slotsForQuery("What is the user working on right now?").size, 0);
  assert.equal(slotsForQuery("What is the user's favorite pizza topping?").size, 0);
  assert.equal(slotsForQuery("How many employees work at Globex?").size, 0);
  assert.equal(slotsForQuery("Where is Globex headquartered?").size, 0);
  assert.equal(slotsForQuery("Where did the user go to university?").size, 0);
  assert.equal(slotsForQuery("What is the user's phone number?").size, 0);
  assert.equal(slotsForQuery("What about the other one?").size, 0);
});
