/**
 * scripts/enrich-topics-number.js
 * ---------------------------------------------------------------------------
 * Question shapes for number sense, the four operations, fractions, decimals,
 * money, patterns and data handling — roughly grades 1 to 7.
 *
 * Each shape is a function of the grade number, so the same shape can serve
 * Grade 3 and Grade 6 with numbers scaled to suit. Every shape returns:
 *
 *     { wa: 'question text', o: <options object>, exp: 'why' }
 *
 * The explanation is not decoration. It is what the child reads in the report
 * afterwards, so it must show the working, not restate the answer.
 * ---------------------------------------------------------------------------
 */

const H = require('./enrich-questions.js');
const { ri, pick, opts, yesNo, among, near, F, red, fmt, gcd, lcm, round2,
  NAMES, THINGS, PLACES } = H;

/** Upper bound for "a number this child works with", by grade. */
const cap = (G) => (G <= 1 ? 20 : G <= 2 ? 99 : G <= 3 ? 999 : G <= 4 ? 9999 : 99999);

/* ========================================================= number sense === */
const placeValue = [
  (G) => { const n = ri(10, cap(G) - 1); return { wa: `➡️ What comes just after ${fmt(n)}?`, o: opts(n + 1, near(n + 1)), exp: `Counting on by one from ${fmt(n)} gives ${fmt(n + 1)}.` }; },
  (G) => { const n = ri(11, cap(G)); return { wa: `⬅️ What comes just before ${fmt(n)}?`, o: opts(n - 1, near(n - 1)), exp: `Counting back by one from ${fmt(n)} gives ${fmt(n - 1)}.` }; },
  (G) => { const n = ri(10, cap(G) - 2); return { wa: `🌉 Which number lies between ${fmt(n)} and ${fmt(n + 2)}?`, o: opts(n + 1, [n, n + 2, n + 3]), exp: `${fmt(n + 1)} sits between ${fmt(n)} and ${fmt(n + 2)}.` }; },
  (G) => { const s = ri(10, cap(G) / 2), st = pick([2, 5, 10, 25, 100].filter((x) => x <= cap(G) / 10 || x <= 10)); return { wa: `🔟 Skip count by ${st}s: ${fmt(s)}, ${fmt(s + st)}, ${fmt(s + 2 * st)}, __?`, o: opts(s + 3 * st, near(s + 3 * st)), exp: `Each step adds ${st}, so after ${fmt(s + 2 * st)} comes ${fmt(s + 3 * st)}.` }; },
  (G) => { const a = ri(10, cap(G)), b = ri(10, cap(G)); if (a === b) return null; const g = Math.max(a, b); return { wa: `🔎 Which is GREATER: ${fmt(a)} or ${fmt(b)}?`, o: opts(g, [Math.min(a, b), g + 1, g - 1]), exp: `Comparing digit by digit from the left, ${fmt(g)} is the greater number.` }; },
  (G) => { const a = ri(10, cap(G)), b = ri(10, cap(G)); if (a === b) return null; const s = Math.min(a, b); return { wa: `🔬 Which is SMALLER: ${fmt(a)} or ${fmt(b)}?`, o: opts(s, [Math.max(a, b), s + 1, s - 1]), exp: `Comparing digit by digit from the left, ${fmt(s)} is the smaller number.` }; },
  (G) => { const d = [ri(1, 9), ri(0, 9), ri(0, 9)]; const n = 100 * d[0] + 10 * d[1] + d[2]; const w = pick([['hundreds', d[0]], ['tens', d[1]], ['ones', d[2]]]); return { wa: `🏠 In ${fmt(n)}, which digit is in the ${w[0]} place?`, o: opts(w[1], [d[0], d[1], d[2], (w[1] + 1) % 10].filter((x) => x !== w[1])), exp: `Writing ${fmt(n)} as ${d[0]} hundreds, ${d[1]} tens and ${d[2]} ones, the ${w[0]} digit is ${w[1]}.` }; },
  (G) => { const h = ri(1, 9), t = ri(0, 9), u = ri(0, 9), n = 100 * h + 10 * t + u; return { wa: `🧱 ${h} hundreds + ${t} tens + ${u} ones = ?`, o: opts(n, near(n)), exp: `${h}×100 = ${h * 100}, ${t}×10 = ${t * 10}, plus ${u} ones. Total ${fmt(n)}.` }; },
  (G) => { const n = ri(10, cap(G) - 10); return { wa: `🚀 Which number is 10 MORE than ${fmt(n)}?`, o: opts(n + 10, [n + 1, n - 10, n + 100]), exp: `${fmt(n)} + 10 = ${fmt(n + 10)}.` }; },
  (G) => { const n = ri(110, cap(G)); return { wa: `🪂 Which number is 100 LESS than ${fmt(n)}?`, o: opts(n - 100, [n - 10, n + 100, n - 1]), exp: `${fmt(n)} − 100 = ${fmt(n - 100)}.` }; },
  (G) => { const nums = Array.from({ length: 4 }, () => ri(10, cap(G))); if (new Set(nums).size !== 4) return null; const big = Math.max(...nums); return { wa: `📊 Which is the LARGEST?\n${nums.join(', ')}`, o: opts(big, nums.filter((x) => x !== big)), exp: `Lining them up, ${fmt(big)} is the largest of ${nums.join(', ')}.` }; },
  (G) => { const d = [ri(1, 9), ri(1, 9), ri(1, 9)]; if (new Set(d).size !== 3) return null; const big = Number([...d].sort((a, b) => b - a).join('')); return { wa: `🔀 Make the BIGGEST 3-digit number using ${d.join(', ')} once each.`, o: opts(big, [Number([...d].sort((a, b) => a - b).join('')), big - 9, big - 90]), exp: `Put the largest digit first: ${[...d].sort((a, b) => b - a).join(' then ')} gives ${fmt(big)}.` }; },
  (G) => { const n = ri(11, cap(G)); const r = Math.round(n / 10) * 10; return { wa: `📏 Round ${fmt(n)} to the nearest 10.`, o: opts(r, [r + 10, r - 10, n]), exp: `${fmt(n)} has ${n % 10} in the ones place, so it rounds to ${fmt(r)}.` }; },
  (G) => { const n = ri(2, Math.min(50, cap(G))); const even = n % 2 === 0; return { wa: `⚖️ Is ${fmt(n)} an even number or an odd number?`, o: among(even ? 'Even' : 'Odd', [even ? 'Odd' : 'Even', 'Both even and odd', 'Neither']), exp: `${fmt(n)} ends in ${n % 10}, so it is ${even ? 'even — it splits into two equal groups' : 'odd — one is always left over'}.` }; },
];

/* ============================================================ operations === */
const addSub = [
  (G) => { const a = ri(10, cap(G)), b = ri(10, cap(G)); return { wa: `➕ ${fmt(a)} + ${fmt(b)} = ?`, o: opts(a + b, near(a + b)), exp: `${fmt(a)} + ${fmt(b)} = ${fmt(a + b)}.` }; },
  (G) => { const a = ri(20, cap(G)), b = ri(10, a - 1); return { wa: `➖ ${fmt(a)} − ${fmt(b)} = ?`, o: opts(a - b, near(a - b)), exp: `${fmt(a)} − ${fmt(b)} = ${fmt(a - b)}.` }; },
  (G) => { const a = ri(10, cap(G) / 2), b = ri(10, cap(G) / 2), N = pick(NAMES), th = pick(THINGS); return { wa: `🛒 ${N} has ${fmt(a)} ${th} and buys ${fmt(b)} more. How many now?`, o: opts(a + b, near(a + b)), exp: `Buying more means adding: ${fmt(a)} + ${fmt(b)} = ${fmt(a + b)}.` }; },
  (G) => { const a = ri(30, cap(G)), b = ri(5, a - 5), N = pick(NAMES), th = pick(THINGS); return { wa: `🎁 ${N} had ${fmt(a)} ${th} and gave away ${fmt(b)}. How many are left?`, o: opts(a - b, near(a - b)), exp: `Giving away means subtracting: ${fmt(a)} − ${fmt(b)} = ${fmt(a - b)}.` }; },
  (G) => { const a = ri(10, cap(G)), s = a + ri(10, cap(G)); return { wa: `🧩 ${fmt(a)} + ⬜ = ${fmt(s)}. What goes in the box?`, o: opts(s - a, near(s - a)), exp: `Undo the addition: ${fmt(s)} − ${fmt(a)} = ${fmt(s - a)}.` }; },
  (G) => { const a = ri(20, cap(G)), b = ri(5, a - 5); return { wa: `🧩 ⬜ − ${fmt(b)} = ${fmt(a - b)}. What goes in the box?`, o: opts(a, near(a)), exp: `Undo the subtraction: ${fmt(a - b)} + ${fmt(b)} = ${fmt(a)}.` }; },
  (G) => { const a = ri(20, cap(G)), b = ri(20, cap(G)); const shown = Math.random() < 0.5 ? a + b : a + b + pick([1, -1, 10, -10]); const ok = shown === a + b; return { wa: `🔎 ${pick(NAMES)} wrote: ${fmt(a)} + ${fmt(b)} = ${fmt(shown)}. Is that right?`, o: yesNo(ok, 'Yes, it is correct', 'No, it is wrong'), exp: `${fmt(a)} + ${fmt(b)} = ${fmt(a + b)}, so the answer shown is ${ok ? 'correct' : 'wrong'}.` }; },
  (G) => { const a = ri(10, cap(G) / 3), b = ri(10, cap(G) / 3), c = ri(10, cap(G) / 3); return { wa: `🧮 ${fmt(a)} + ${fmt(b)} + ${fmt(c)} = ?`, o: opts(a + b + c, near(a + b + c)), exp: `${fmt(a)} + ${fmt(b)} = ${fmt(a + b)}, then + ${fmt(c)} = ${fmt(a + b + c)}.` }; },
  (G) => { const big = ri(50, cap(G)), sm = ri(10, big - 10); return { wa: `📐 How much MORE is ${fmt(big)} than ${fmt(sm)}?`, o: opts(big - sm, near(big - sm)), exp: `"How much more" means subtract: ${fmt(big)} − ${fmt(sm)} = ${fmt(big - sm)}.` }; },
  (G) => { const spent = ri(20, 400), paid = spent + ri(10, 200), N = pick(NAMES); return { wa: `💰 ${N} paid ₹${fmt(paid)} for something costing ₹${fmt(spent)}. What change comes back?`, o: opts(paid - spent, near(paid - spent)), exp: `Change = paid − cost = ₹${fmt(paid)} − ₹${fmt(spent)} = ₹${fmt(paid - spent)}.` }; },
];

const mulDiv = [
  (G) => { const a = ri(2, 9), b = ri(2, 9); return { wa: `✖️ ${a} × ${b} = ?`, o: opts(a * b, near(a * b)), exp: `${a} × ${b} = ${a * b}.` }; },
  (G) => { const a = ri(11, G >= 5 ? 999 : 99), b = ri(2, 9); return { wa: `✖️ ${fmt(a)} × ${b} = ?`, o: opts(a * b, [a * b + b, a * b - b, a * b + 10]), exp: `${fmt(a)} × ${b} = ${fmt(a * b)}.` }; },
  (G) => { const q = ri(3, G >= 5 ? 200 : 30), m = ri(2, 9); return { wa: `➗ ${fmt(q * m)} ÷ ${m} = ?`, o: opts(q, near(q)), exp: `${m} × ${fmt(q)} = ${fmt(q * m)}, so ${fmt(q * m)} ÷ ${m} = ${fmt(q)}.` }; },
  (G) => { const g = ri(3, 12), each = ri(3, 15), N = pick(NAMES), th = pick(THINGS); return { wa: `📦 ${N} has ${g} boxes with ${each} ${th} in each. How many in all?`, o: opts(g * each, near(g * each)), exp: `Equal groups means multiply: ${g} × ${each} = ${g * each}.` }; },
  (G) => { const m = ri(3, 9), q = ri(4, 30), N = pick(NAMES), th = pick(THINGS); return { wa: `🍬 ${N} shares ${fmt(q * m)} ${th} equally among ${m} friends. How many does each get?`, o: opts(q, near(q)), exp: `Sharing equally means divide: ${fmt(q * m)} ÷ ${m} = ${q} each.` }; },
  (G) => { const m = ri(3, 9), q = ri(5, 40), r = ri(1, m - 1); return { wa: `🧮 ${fmt(q * m + r)} ÷ ${m} — what is the REMAINDER?`, o: opts(r, [0, m - r, (r % (m - 1)) + 1, r + 1].filter((x) => x !== r)), exp: `${fmt(q * m + r)} = ${m} × ${q} + ${r}, so ${q} groups are made and ${r} is left over.` }; },
  (G) => { const a = ri(3, 12), q = ri(3, 12); return { wa: `🧩 ${a} × ⬜ = ${a * q}. What is the missing number?`, o: opts(q, near(q)), exp: `Undo the multiplication: ${a * q} ÷ ${a} = ${q}.` }; },
  (G) => { const r = ri(3, 12), c = ri(3, 12); return { wa: `🔲 A grid has ${r} rows with ${c} dots in each row. How many dots altogether?`, o: opts(r * c, near(r * c)), exp: `Rows × columns = ${r} × ${c} = ${r * c} dots.` }; },
  (G) => { const each = ri(6, 90), n = ri(3, 9); return { wa: `💰 One notebook costs ₹${each}. What do ${n} notebooks cost?`, o: opts(n * each, near(n * each)), exp: `${n} × ₹${each} = ₹${fmt(n * each)}.` }; },
  (G) => { const one = ri(6, 60), m = ri(3, 9); return { wa: `🏷️ ${m} identical pens cost ₹${fmt(one * m)} in total. What does ONE pen cost?`, o: opts(one, near(one)), exp: `₹${fmt(one * m)} ÷ ${m} = ₹${one} for one pen.` }; },
  (G) => { const a = ri(3, 12), b = ri(3, 12), c = ri(3, 12); const p1 = a * b, p2 = a * c; if (p1 === p2) return null; const g = Math.max(p1, p2); return { wa: `🔎 Which is GREATER: ${a} × ${b} or ${a} × ${c}?`, o: opts(g, [Math.min(p1, p2), g + a, g - a]), exp: `${a}×${b} = ${p1} and ${a}×${c} = ${p2}, so ${g} is greater.` }; },
  (G) => { const a = ri(2, 9); return { wa: `🐾 Continue the pattern: ${a}, ${2 * a}, ${3 * a}, __?`, o: opts(4 * a, near(4 * a)), exp: `Each step adds ${a}, so the next number is ${4 * a}.` }; },
  (G) => { const m = ri(3, 9), q = ri(10, 60); const shown = Math.random() < 0.5 ? q : q + pick([1, -1, 2]); const ok = shown === q; return { wa: `🔎 Is ${fmt(q * m)} ÷ ${m} = ${shown}?`, o: yesNo(ok, 'Yes', 'No'), exp: `${fmt(q * m)} ÷ ${m} = ${q}, so the statement is ${ok ? 'correct' : 'wrong'}.` }; },
  (G) => { const total = ri(4, 20) * ri(2, 6), per = pick([2, 3, 4, 5, 6].filter((x) => total % x === 0)); return { wa: `🍽️ ${total} coconuts are packed ${per} to a box. How many boxes are needed?`, o: opts(total / per, near(total / per)), exp: `${total} ÷ ${per} = ${total / per} boxes.` }; },
];

/* ============================================================= fractions === */
const fractions = [
  (G) => { const d = ri(3, 12), a = ri(1, d - 1), b = ri(1, d - a); return { wa: `➕ ${a}/${d} + ${b}/${d} = ?`, o: opts(F(a + b, d), [F(a + b, 2 * d), `${a + b}/${2 * d}`, F(a + b + 1, d)]), exp: `Same denominator, so add the tops: ${a} + ${b} = ${a + b}, giving ${a + b}/${d} = ${F(a + b, d)}.` }; },
  (G) => { const d = ri(3, 12), a = ri(2, d - 1), b = ri(1, a - 1); return { wa: `➖ ${a}/${d} − ${b}/${d} = ?`, o: opts(F(a - b, d), [F(a + b, d), `${a - b}/${2 * d}`, F(a - b + 1, d)]), exp: `Same denominator, so subtract the tops: ${a} − ${b} = ${a - b}, giving ${F(a - b, d)}.` }; },
  (G) => { const d1 = pick([2, 3, 4, 6]), d2 = pick([2, 3, 4, 6].filter((x) => x !== d1)); const a = ri(1, d1 - 1), b = ri(1, d2 - 1); const L = lcm(d1, d2); const n = a * (L / d1) + b * (L / d2); return { wa: `➕ ${a}/${d1} + ${b}/${d2} = ?`, o: opts(F(n, L), [`${a + b}/${d1 + d2}`, F(n + 1, L), F(n - 1, L)]), exp: `The LCM of ${d1} and ${d2} is ${L}. So ${a}/${d1} = ${a * (L / d1)}/${L} and ${b}/${d2} = ${b * (L / d2)}/${L}. Adding gives ${n}/${L} = ${F(n, L)}.` }; },
  (G) => { const k = ri(2, 6), a = ri(1, 8), d = ri(a + 1, 12); return { wa: `🟰 Which fraction is EQUAL to ${a}/${d}?`, o: opts(`${a * k}/${d * k}`, [`${a + k}/${d + k}`, `${a * k}/${d}`, `${a}/${d * k}`]), exp: `Multiply top and bottom by the same number ${k}: ${a}/${d} = ${a * k}/${d * k}.` }; },
  (G) => { const g = ri(2, 8), a = ri(2, 9), d = ri(a + 1, 12); return { wa: `✂️ Reduce ${a * g}/${d * g} to its simplest form.`, o: opts(F(a, d), [`${a * g}/${d}`, F(a + 1, d), `${a}/${d * g}`]), exp: `Both ${a * g} and ${d * g} divide by ${g}, leaving ${F(a, d)}.` }; },
  (G) => { const d = ri(3, 12), a = ri(1, d - 1), b = ri(1, d - 1); if (a === b) return null; const big = a > b ? `${a}/${d}` : `${b}/${d}`; return { wa: `🔎 Which is GREATER: ${a}/${d} or ${b}/${d}?`, o: among(big, [a > b ? `${b}/${d}` : `${a}/${d}`, 'They are equal', 'Cannot be compared']), exp: `With the same denominator, the fraction with the bigger top is greater — ${big}.` }; },
  (G) => { const d = ri(2, 8), whole = d * ri(2, 20); return { wa: `🍕 What is 1/${d} of ${whole}?`, o: opts(whole / d, near(whole / d)), exp: `"1/${d} of" means divide by ${d}: ${whole} ÷ ${d} = ${whole / d}.` }; },
  (G) => { const d = ri(3, 10), a = ri(2, d - 1), whole = d * ri(2, 15); return { wa: `🍰 What is ${a}/${d} of ${whole}?`, o: opts((whole / d) * a, near((whole / d) * a)), exp: `One part is ${whole} ÷ ${d} = ${whole / d}, so ${a} parts are ${a} × ${whole / d} = ${(whole / d) * a}.` }; },
  (G) => { const a = ri(1, 6), b = ri(2, 9), c = ri(1, 6), d = ri(2, 9); return { wa: `✖️ ${a}/${b} × ${c}/${d} = ?`, o: opts(F(a * c, b * d), [F(a + c, b + d), F(a * d, b * c), F(a * c + 1, b * d)]), exp: `Multiply tops and bottoms: (${a}×${c})/(${b}×${d}) = ${a * c}/${b * d} = ${F(a * c, b * d)}.` }; },
  (G) => { const a = ri(1, 6), b = ri(2, 9), c = ri(1, 6), d = ri(2, 9); return { wa: `➗ ${a}/${b} ÷ ${c}/${d} = ?`, o: opts(F(a * d, b * c), [F(a * c, b * d), F(a + d, b + c), F(a * d + 1, b * c)]), exp: `Dividing means multiplying by the flip: ${a}/${b} × ${d}/${c} = ${a * d}/${b * c} = ${F(a * d, b * c)}.` }; },
  (G) => { const d = ri(2, 9), w = ri(1, 6), n = ri(1, d - 1); return { wa: `🔄 Write ${w} ${n}/${d} as an improper fraction.`, o: opts(`${w * d + n}/${d}`, [`${w + n}/${d}`, `${w * d}/${d}`, `${w * d + n + 1}/${d}`]), exp: `${w} wholes are ${w}×${d} = ${w * d} parts. Add ${n} more: ${w * d + n}/${d}.` }; },
  (G) => { const d = ri(2, 9), w = ri(2, 6), n = ri(1, d - 1); const imp = w * d + n; return { wa: `🔄 Write ${imp}/${d} as a mixed number.`, o: among(`${w} ${n}/${d}`, [`${w} ${d}/${n}`, `${w + 1} ${n}/${d}`, `${n} ${w}/${d}`]), exp: `${imp} ÷ ${d} = ${w} remainder ${n}, so it is ${w} ${n}/${d}.` }; },
  (G) => { const d = ri(3, 10), a = ri(1, d - 1); return { wa: `🧩 ${a}/${d} + ⬜ = 1. What is the missing fraction?`, o: opts(F(d - a, d), [F(a, d), F(d + a, d), F(d - a - 1, d)]), exp: `A whole is ${d}/${d}. Take away ${a}/${d} and ${d - a}/${d} = ${F(d - a, d)} is left.` }; },
  (G) => { const d = pick([2, 4, 5, 10, 20]); const a = ri(1, d - 1); const v = round2(a / d); return { wa: `🔢 Write ${a}/${d} as a decimal.`, o: opts(v, [round2(v + 0.1), round2(v * 10), round2(v / 10)].filter((x) => x > 0)), exp: `${a} ÷ ${d} = ${v}.` }; },
];

/* ============================================================== decimals === */
const decimals = [
  (G) => { const a = round2(ri(11, 999) / 10), b = round2(ri(11, 999) / 10); return { wa: `➕ ${a} + ${b} = ?`, o: opts(round2(a + b), near(round2(a + b))), exp: `Line up the decimal points: ${a} + ${b} = ${round2(a + b)}.` }; },
  (G) => { const a = round2(ri(200, 999) / 10), b = round2(ri(11, 199) / 10); return { wa: `➖ ${a} − ${b} = ?`, o: opts(round2(a - b), near(round2(a - b))), exp: `Line up the decimal points: ${a} − ${b} = ${round2(a - b)}.` }; },
  (G) => { const a = round2(ri(11, 99) / 10), b = round2(ri(11, 99) / 10); const p = round2(a * b); return { wa: `✖️ ${a} × ${b} = ?`, o: opts(p, [round2(p * 10), round2(p / 10), round2(p + 0.1)]), exp: `${a * 10} × ${b * 10} = ${a * 10 * b * 10}. There are 2 decimal places in all, so the answer is ${p}.` }; },
  (G) => { const q = round2(ri(11, 99) / 10), m = ri(2, 9); return { wa: `➗ ${round2(q * m)} ÷ ${m} = ?`, o: opts(q, [round2(q * 10), round2(q / 10), round2(q + 0.1)]), exp: `${round2(q * m)} ÷ ${m} = ${q}.` }; },
  (G) => { const a = round2(ri(10, 99) / 10); const k = pick([10, 100]); return { wa: `🔟 ${a} × ${k} = ?`, o: opts(round2(a * k), [round2(a * k * 10), round2(a * k / 10), round2(a + k)]), exp: `Multiplying by ${k} moves the decimal point ${String(k).length - 1} place(s) right: ${round2(a * k)}.` }; },
  (G) => { const a = ri(11, 999); const k = pick([10, 100]); return { wa: `🔟 ${a} ÷ ${k} = ?`, o: opts(round2(a / k), [round2(a / (k * 10)), round2(a * k), round2(a / k + 1)]), exp: `Dividing by ${k} moves the decimal point ${String(k).length - 1} place(s) left: ${round2(a / k)}.` }; },
  (G) => { const a = round2(ri(11, 999) / 100), b = round2(ri(11, 999) / 100); if (a === b) return null; const g = Math.max(a, b); return { wa: `🔎 Which is GREATER: ${a} or ${b}?`, o: among(String(g), [String(Math.min(a, b)), 'They are equal', 'Cannot be compared']), exp: `Compare the whole parts first, then tenths, then hundredths — ${g} is greater.` }; },
  (G) => { const a = round2(ri(11, 999) / 10); const r = Math.round(a); return { wa: `📏 Round ${a} to the nearest whole number.`, o: opts(r, [r + 1, r - 1, Math.floor(a)] .filter((x, i, s) => s.indexOf(x) === i)), exp: `The digit after the point is ${String(a).split('.')[1] || 0}, so ${a} rounds to ${r}.` }; },
  (G) => { const d = pick([2, 4, 5, 8, 10, 20, 25]); const a = ri(1, d - 1); return { wa: `🔄 Write ${a}/${d} as a decimal.`, o: opts(round2(a / d), [round2(a / d * 10), round2(a / d / 10), round2(a / d + 0.1)]), exp: `${a} ÷ ${d} = ${round2(a / d)}.` }; },
  (G) => { const n = ri(1, 99); return { wa: `🔄 Write 0.${String(n).padStart(2, '0')} as a fraction in simplest form.`, o: opts(F(n, 100), [`${n}/10`, `${n}/1000`, F(n + 1, 100)]), exp: `0.${String(n).padStart(2, '0')} means ${n} hundredths = ${n}/100 = ${F(n, 100)}.` }; },
  (G) => { const price = round2(ri(50, 900) / 10), n = ri(2, 6), N = pick(NAMES); return { wa: `💰 ${N} buys ${n} kg of rice at ₹${price} per kg. What is the total?`, o: opts(round2(price * n), near(round2(price * n))), exp: `${n} × ₹${price} = ₹${round2(price * n)}.` }; },
  // The tenths digit is chosen first, so the number always HAS one — dividing
  // a random integer by 10 lands on a whole number one time in ten.
  (G) => { const w = ri(1, 99), t = ri(1, 9); const a = round2(w + t / 10); return { wa: `🏠 In the number ${a}, what does the digit ${t} stand for?`, o: among(`${t} tenths`, [`${t} ones`, `${t} hundredths`, `${t} tens`]), exp: `The first place after the decimal point is tenths, so the ${t} in ${a} means ${t} tenths.` }; },
];

/* ================================================================== money === */
const money = [
  (G) => { const a = ri(10, 500), b = ri(10, 500); return { wa: `💵 ₹${fmt(a)} + ₹${fmt(b)} = ?`, o: opts(a + b, near(a + b)), exp: `₹${fmt(a)} + ₹${fmt(b)} = ₹${fmt(a + b)}.` }; },
  (G) => { const cost = ri(20, 400), paid = pick([50, 100, 200, 500, 1000].filter((x) => x > cost)), N = pick(NAMES); return { wa: `🧾 ${N} buys a toy for ₹${cost} and pays with a ₹${paid} note. What change comes back?`, o: opts(paid - cost, near(paid - cost)), exp: `₹${paid} − ₹${cost} = ₹${paid - cost} change.` }; },
  (G) => { const each = ri(5, 60), n = ri(2, 9), th = pick(THINGS); return { wa: `🏪 Each of the ${th} costs ₹${each}. What do ${n} cost?`, o: opts(each * n, near(each * n)), exp: `${n} × ₹${each} = ₹${fmt(each * n)}.` }; },
  (G) => { const one = ri(8, 70), m = ri(3, 8); return { wa: `🏷️ ${m} identical items cost ₹${fmt(one * m)}. What does one cost?`, o: opts(one, near(one)), exp: `₹${fmt(one * m)} ÷ ${m} = ₹${one}.` }; },
  (G) => { const notes = pick([10, 20, 50, 100]), n = ri(3, 12); return { wa: `💳 How many ₹${notes} notes make ₹${fmt(notes * n)}?`, o: opts(n, near(n)), exp: `₹${fmt(notes * n)} ÷ ₹${notes} = ${n} notes.` }; },
  (G) => { const budget = ri(100, 900), spent = ri(20, budget - 20), N = pick(NAMES); return { wa: `👛 ${N} took ₹${fmt(budget)} to ${pick(PLACES)} and spent ₹${fmt(spent)}. How much is left?`, o: opts(budget - spent, near(budget - spent)), exp: `₹${fmt(budget)} − ₹${fmt(spent)} = ₹${fmt(budget - spent)} left.` }; },
  (G) => { const r = ri(20, 90), p = ri(5, 95); return { wa: `🪙 Write ₹${r}.${String(p).padStart(2, '0')} in paise.`, o: opts(r * 100 + p, [r * 100, r + p, (r * 100 + p) * 10]), exp: `₹1 = 100 paise, so ₹${r} = ${fmt(r * 100)} paise, plus ${p} paise = ${fmt(r * 100 + p)} paise.` }; },
  (G) => { const cost = ri(30, 200), have = ri(5, cost - 5), N = pick(NAMES); return { wa: `😟 A book costs ₹${cost} but ${N} has only ₹${have}. How much more is needed?`, o: opts(cost - have, near(cost - have)), exp: `₹${cost} − ₹${have} = ₹${cost - have} more needed.` }; },
  (G) => { const a = ri(20, 200), b = ri(20, 200); if (a === b) return null; return { wa: `🔎 Which costs MORE: a bag at ₹${a} or a lunchbox at ₹${b}?`, o: among(a > b ? `The bag, at ₹${a}` : `The lunchbox, at ₹${b}`, [a > b ? `The lunchbox, at ₹${b}` : `The bag, at ₹${a}`, 'They cost the same', 'Cannot be decided']), exp: `₹${Math.max(a, b)} is more than ₹${Math.min(a, b)}.` }; },
  (G) => { const day = ri(10, 90), days = ri(4, 12), N = pick(NAMES); return { wa: `🐷 ${N} saves ₹${day} every day. How much is saved in ${days} days?`, o: opts(day * days, near(day * days)), exp: `${days} × ₹${day} = ₹${fmt(day * days)}.` }; },
];

/* =============================================================== patterns === */
const patterns = [
  (G) => { const s = ri(2, 30), d = ri(2, 9); return { wa: `🔢 What comes next? ${s}, ${s + d}, ${s + 2 * d}, ${s + 3 * d}, __?`, o: opts(s + 4 * d, near(s + 4 * d)), exp: `Each number goes up by ${d}, so the next is ${s + 3 * d} + ${d} = ${s + 4 * d}.` }; },
  (G) => { const s = ri(40, 99), d = ri(2, 9); return { wa: `🔻 What comes next? ${s}, ${s - d}, ${s - 2 * d}, ${s - 3 * d}, __?`, o: opts(s - 4 * d, near(s - 4 * d)), exp: `Each number goes down by ${d}, so the next is ${s - 3 * d} − ${d} = ${s - 4 * d}.` }; },
  (G) => { const s = ri(2, 5), r = ri(2, 3); return { wa: `✖️ What comes next? ${s}, ${s * r}, ${s * r * r}, __?`, o: opts(s * r ** 3, [s * r ** 3 + r, s * r * r + r, s * r ** 4]), exp: `Each number is multiplied by ${r}, so the next is ${s * r * r} × ${r} = ${s * r ** 3}.` }; },
  (G) => { const s = ri(2, 20), d = ri(2, 9); return { wa: `🧩 Find the missing number: ${s}, ${s + d}, __, ${s + 3 * d}`, o: opts(s + 2 * d, near(s + 2 * d)), exp: `The pattern adds ${d} each time, so the gap is ${s + d} + ${d} = ${s + 2 * d}.` }; },
  (G) => { const n = ri(3, 9); return { wa: `⬜ A pattern of squares grows 1, 4, 9, 16, ... What is the ${n}th number?`, o: opts(n * n, [n * n + n, (n + 1) ** 2, n * 2]), exp: `These are square numbers, so the ${n}th is ${n} × ${n} = ${n * n}.` }; },
  (G) => { const start = ri(1, 5); return { wa: `🔺 The pattern goes ${start}, ${start + 1}, ${start + 3}, ${start + 6}, __? (the jump grows by 1 each time)`, o: opts(start + 10, [start + 9, start + 11, start + 8]), exp: `The jumps are 1, 2, 3, then 4. So ${start + 6} + 4 = ${start + 10}.` }; },
  (G) => { const sh = ['🔴', '🔵', '🟡']; const k = ri(0, 2); return { wa: `🎨 What comes next? ${sh[0]}${sh[1]}${sh[2]} ${sh[0]}${sh[1]}${sh[2]} ${sh.slice(0, k).join('')}__`, o: among(sh[k], [sh[(k + 1) % 3], sh[(k + 2) % 3], 'The pattern ends here']), exp: `The pattern repeats ${sh.join('')} over and over, so ${sh[k]} comes next.` }; },
  (G) => { const s = ri(2, 9); return { wa: `🐾 Skip count in ${s}s: ${s}, ${2 * s}, ${3 * s}, ${4 * s}, __?`, o: opts(5 * s, near(5 * s)), exp: `Adding ${s} each time: ${4 * s} + ${s} = ${5 * s}.` }; },
  (G) => { const a = ri(1, 9), b = ri(1, 9); return { wa: `🔁 In the pattern ${a}, ${b}, ${a}, ${b}, ${a}, __ — what comes next?`, o: opts(b, [a, a + b, b + 1]), exp: `The two numbers alternate, so after ${a} comes ${b}.` }; },
  (G) => { const d = ri(2, 9), s = ri(2, 20); return { wa: `🕵️ Which number does NOT belong? ${s}, ${s + d}, ${s + 2 * d + 1}, ${s + 3 * d}`, o: opts(s + 2 * d + 1, [s, s + d, s + 3 * d]), exp: `The pattern adds ${d} each time, which would give ${s + 2 * d} — not ${s + 2 * d + 1}.` }; },
  (G) => { const n = ri(4, 12); return { wa: `🔢 The pattern is 2, 4, 6, 8, ... What is the ${n}th number?`, o: opts(2 * n, [2 * n + 2, 2 * n - 2, n]), exp: `These are the even numbers, so the ${n}th is 2 × ${n} = ${2 * n}.` }; },
  (G) => { const n = ri(3, 10); return { wa: `🔺 Triangular numbers go 1, 3, 6, 10, ... What is the ${n}th?`, o: opts((n * (n + 1)) / 2, [(n * (n + 1)) / 2 + n, ((n + 1) * (n + 2)) / 2, n * n]), exp: `The ${n}th triangular number is ${n}×${n + 1}÷2 = ${(n * (n + 1)) / 2}.` }; },
];

/* ========================================================== data handling === */
const dataHandling = [
  (G) => { const v = Array.from({ length: 5 }, () => ri(2, 40)); const s = v.reduce((a, b) => a + b, 0); return { wa: `📊 A tally shows ${v.join(', ')} books read in five weeks. How many in all?`, o: opts(s, near(s)), exp: `${v.join(' + ')} = ${s} books.` }; },
  (G) => { const v = Array.from({ length: 5 }, () => ri(2, 40)); if (new Set(v).size !== 5) return null; const m = Math.max(...v); const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']; return { wa: `📈 Ice creams sold — ${days.map((d, i) => `${d}: ${v[i]}`).join(', ')}. Which day sold the MOST?`, o: among(days[v.indexOf(m)], days.filter((_, i) => v[i] !== m).slice(0, 3)), exp: `${m} is the largest count, and that was on ${days[v.indexOf(m)]}.` }; },
  (G) => { const v = Array.from({ length: 5 }, () => ri(2, 40)); if (new Set(v).size !== 5) return null; const m = Math.min(...v); const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']; return { wa: `📉 Ice creams sold — ${days.map((d, i) => `${d}: ${v[i]}`).join(', ')}. Which day sold the FEWEST?`, o: among(days[v.indexOf(m)], days.filter((_, i) => v[i] !== m).slice(0, 3)), exp: `${m} is the smallest count, and that was on ${days[v.indexOf(m)]}.` }; },
  (G) => { const a = ri(5, 40), b = ri(5, 40); if (a === b) return null; return { wa: `⚖️ Class A planted ${a} saplings, Class B planted ${b}. How many MORE did the bigger class plant?`, o: opts(Math.abs(a - b), near(Math.abs(a - b))), exp: `${Math.max(a, b)} − ${Math.min(a, b)} = ${Math.abs(a - b)} more.` }; },
  (G) => { const each = pick([2, 5, 10]), pics = ri(3, 9); return { wa: `🖼️ In a picture graph, one 🍎 stands for ${each} apples. What do ${pics} 🍎 stand for?`, o: opts(each * pics, near(each * pics)), exp: `${pics} × ${each} = ${each * pics} apples.` }; },
  (G) => { const v = Array.from({ length: 4 }, () => ri(10, 50)); const s = v.reduce((a, b) => a + b, 0); const k = ri(0, 3); return { wa: `🥧 Votes: ${v.join(', ')}. What fraction of all votes did the group with ${v[k]} votes get?`, o: opts(F(v[k], s), [F(v[k], s + 1), `${v[k]}/${v[k]}`, F(v[k] + 1, s)]), exp: `Total votes = ${s}, so the fraction is ${v[k]}/${s} = ${F(v[k], s)}.` }; },
  (G) => { const v = Array.from({ length: 5 }, () => ri(2, 20)); const s = v.reduce((a, b) => a + b, 0); return { wa: `📋 Marks scored: ${v.join(', ')}. What is the average?`, o: opts(round2(s / 5), [round2(s / 4), s, round2(s / 5 + 1)]), exp: `Average = total ÷ how many = ${s} ÷ 5 = ${round2(s / 5)}.` }; },
  (G) => { const t = ri(4, 12); return { wa: `✏️ In a tally chart, |||| crossed through means 5. What do ${t} full groups stand for?`, o: opts(t * 5, near(t * 5)), exp: `Each crossed group is 5, so ${t} × 5 = ${t * 5}.` }; },
  (G) => { const boys = ri(10, 30), girls = ri(10, 30); return { wa: `👥 A class has ${boys} boys and ${girls} girls. How many children in all?`, o: opts(boys + girls, near(boys + girls)), exp: `${boys} + ${girls} = ${boys + girls} children.` }; },
  (G) => { const v = Array.from({ length: 4 }, () => ri(5, 30)); const s = v.reduce((a, b) => a + b, 0); const two = v[0] + v[1]; return { wa: `➗ Four shops sold ${v.join(', ')} kites. How many did the FIRST TWO sell together?`, o: opts(two, [s, two + v[2], Math.abs(v[0] - v[1])]), exp: `${v[0]} + ${v[1]} = ${two} kites.` }; },
];

module.exports = { placeValue, addSub, mulDiv, fractions, decimals, money, patterns, dataHandling };
