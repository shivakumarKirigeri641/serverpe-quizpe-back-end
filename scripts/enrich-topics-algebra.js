/**
 * scripts/enrich-topics-algebra.js
 * ---------------------------------------------------------------------------
 * Question shapes for grades 6 to 10: integers, number theory, exponents,
 * algebra, equations, sets, commercial arithmetic and number systems.
 *
 * Numbers are chosen so the answer comes out clean. A child practising
 * factorisation should be thinking about factors, not fighting an ugly
 * fraction that the generator happened to produce.
 * ---------------------------------------------------------------------------
 */

const H = require('./enrich-questions.js');
const { ri, pick, opts, yesNo, among, near, F, fmt, gcd, lcm, round2, NAMES, THINGS } = H;

/** Formats a signed term the way it is written by hand: 3x − 4, not 3x + -4. */
const sgn = (n) => (n < 0 ? `− ${Math.abs(n)}` : `+ ${n}`);
/** A coefficient of 1 is never written: x, not 1x. */
/** '+ x' not '+ 1x' — a signed term whose coefficient is 1. */
const sgnCo = (n, v = 'x') => (n < 0 ? '− ' : '+ ') + (Math.abs(n) === 1 ? v : Math.abs(n) + v);
const co = (a, v = 'x') => `${a === 1 ? '' : a === -1 ? '−' : a}${v}`;

/* =============================================================== integers === */
const integers = [
  () => { const a = ri(-30, -1), b = ri(1, 30); return { wa: `➕ (${a}) + ${b} = ?`, o: opts(a + b, near(a + b)), exp: `Adding a positive to a negative moves right on the number line: ${a} + ${b} = ${a + b}.` }; },
  () => { const a = ri(-30, -1), b = ri(-30, -1); return { wa: `➕ (${a}) + (${b}) = ?`, o: opts(a + b, near(a + b)), exp: `Two negatives move further left: ${a} + ${b} = ${a + b}.` }; },
  () => { const a = ri(-20, 20), b = ri(-20, 20); return { wa: `➖ (${a}) − (${b}) = ?`, o: opts(a - b, near(a - b)), exp: `Subtracting ${b} is the same as adding ${-b}: ${a} + (${-b}) = ${a - b}.` }; },
  () => { const a = ri(-12, -2), b = ri(2, 12); return { wa: `✖️ (${a}) × ${b} = ?`, o: opts(a * b, [-a * b, a * b + b, a * b - b]), exp: `A negative times a positive is negative: ${a} × ${b} = ${a * b}.` }; },
  () => { const a = ri(-12, -2), b = ri(-12, -2); return { wa: `✖️ (${a}) × (${b}) = ?`, o: opts(a * b, [-a * b, a * b + 1, a * b - 1]), exp: `A negative times a negative is positive: ${a} × ${b} = ${a * b}.` }; },
  () => { const q = ri(2, 12), b = ri(2, 9); return { wa: `➗ (${-q * b}) ÷ ${b} = ?`, o: opts(-q, [q, -q + 1, -q - 1]), exp: `${-q * b} ÷ ${b} = ${-q}. Negative divided by positive is negative.` }; },
  () => { const a = ri(-30, 30), b = ri(-30, 30); if (a === b) return null; const g = Math.max(a, b); return { wa: `🔎 Which is GREATER: ${a} or ${b}?`, o: opts(g, [Math.min(a, b), g + 1, g - 1]), exp: `On the number line ${g} lies to the right of ${Math.min(a, b)}, so ${g} is greater.` }; },
  () => { const n = ri(-40, -1); return { wa: `📐 What is the absolute value of ${n}?`, o: opts(Math.abs(n), [n, Math.abs(n) + 1, 0]), exp: `Absolute value is the distance from zero, always positive: |${n}| = ${Math.abs(n)}.` }; },
  () => { const t = ri(-15, -2), r = ri(3, 20); return { wa: `🌡️ The temperature was ${t}°C and rose by ${r}°C. What is it now?`, o: opts(t + r, near(t + r)), exp: `${t} + ${r} = ${t + r}°C.` }; },
  () => { const f = ri(2, 8), d = ri(3, 12); return { wa: `🛗 A lift starts at floor ${f} and goes down ${d} floors. Where does it stop?`, o: opts(f - d, near(f - d)), exp: `${f} − ${d} = ${f - d}, so it stops at ${f - d < 0 ? `basement level ${Math.abs(f - d)}` : `floor ${f - d}`}.` }; },
  () => { const n = ri(-20, -1); return { wa: `🔁 What is the additive inverse of ${n}?`, o: opts(-n, [n, 0, -n + 1]), exp: `The additive inverse adds to zero: ${n} + ${-n} = 0, so it is ${-n}.` }; },
  () => { const a = ri(-15, 15), b = ri(-15, 15), c = ri(-15, 15); return { wa: `🧮 (${a}) + (${b}) − (${c}) = ?`, o: opts(a + b - c, near(a + b - c)), exp: `${a} + ${b} = ${a + b}, then ${a + b} − ${c} = ${a + b - c}.` }; },
];

/* ==================================================== factors and multiples === */
const numberTheory = [
  // Both numbers are given a shared factor on purpose. Two random numbers are
  // usually coprime, and "the HCF is 1" teaches nothing about finding an HCF.
  () => { const g = ri(2, 12), p = ri(2, 9), q = ri(2, 9); if (gcd(p, q) !== 1) return null; const a = g * p, b = g * q; return { wa: `🔗 What is the HCF of ${a} and ${b}?`, o: opts(g, [a * b, g * 2, g + 1, lcm(a, b)]), exp: `${a} = ${g}×${p} and ${b} = ${g}×${q}, and ${p} and ${q} share nothing further — so the HCF is ${g}.` }; },
  () => { const g = ri(2, 8), p = ri(2, 7), q = ri(2, 7); if (gcd(p, q) !== 1) return null; const a = g * p, b = g * q; return { wa: `🔗 What is the LCM of ${a} and ${b}?`, o: opts(lcm(a, b), [g, a * b, lcm(a, b) + a]), exp: `HCF is ${g}, so LCM = ${a}×${b} ÷ ${g} = ${lcm(a, b)}.` }; },
  () => { const p = pick([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]); return { wa: `🔢 Is ${p} a prime number?`, o: yesNo(true, 'Yes, it is prime', 'No, it is composite'), exp: `${p} has exactly two factors, 1 and ${p}, so it is prime.` }; },
  () => { const c = pick([4, 6, 8, 9, 12, 15, 16, 18, 20, 21, 25, 27]); const f = []; for (let i = 2; i * i <= c; i++) if (c % i === 0) f.push(i); return { wa: `🔢 Is ${c} a prime number?`, o: yesNo(false, 'Yes, it is prime', 'No, it is composite'), exp: `${c} can be divided by ${f[0]} as well as 1 and itself, so it is composite.` }; },
  () => { const n = pick([12, 18, 20, 24, 28, 30, 36, 40, 45, 48, 50, 60]); let c = 0; for (let i = 1; i <= n; i++) if (n % i === 0) c++; return { wa: `🧮 How many factors does ${n} have?`, o: opts(c, [c + 1, c - 1, c + 2]), exp: `The factors of ${n} are ${Array.from({ length: n }, (_, i) => i + 1).filter((i) => n % i === 0).join(', ')} — that is ${c} of them.` }; },
  () => { const n = pick([12, 18, 20, 24, 28, 30, 36, 40, 45]); const pf = []; let m = n; for (let p = 2; p <= m; p++) while (m % p === 0) { pf.push(p); m /= p; } return { wa: `🌳 Write ${n} as a product of prime factors.`, o: among(pf.join(' × '), [pf.slice(0, -1).join(' × ') || '1', `${n} × 1`, pf.map((x) => x + 1).join(' × ')]), exp: `Breaking ${n} down: ${pf.join(' × ')} = ${n}, and every factor there is prime.` }; },
  () => { const a = ri(6, 40), b = ri(6, 40); return { wa: `🔁 Check: is HCF(${a},${b}) × LCM(${a},${b}) equal to ${a} × ${b}?`, o: yesNo(true, 'Yes, always', 'No, never'), exp: `${gcd(a, b)} × ${lcm(a, b)} = ${gcd(a, b) * lcm(a, b)} and ${a} × ${b} = ${a * b}. They match — this is always true for two numbers.` }; },
  () => { const d = pick([2, 3, 4, 5, 6, 9, 10]); const n = ri(100, 999); const ok = n % d === 0; return { wa: `🔍 Is ${n} divisible by ${d}?`, o: yesNo(ok, 'Yes', 'No'), exp: `${n} ÷ ${d} = ${round2(n / d)}${ok ? ', a whole number, so yes' : `, which is not a whole number (remainder ${n % d}), so no`}.` }; },
  () => { const n = ri(3, 15), k = ri(3, 9); return { wa: `📋 Which of these is a multiple of ${n}?`, o: opts(n * k, [n * k + 1, n * k - 1, n * k + 2]), exp: `${n} × ${k} = ${n * k}, so ${n * k} is a multiple of ${n}.` }; },
  () => { const a = ri(3, 12), b = ri(3, 12); const L = lcm(a, b); return { wa: `🔔 Two bells ring every ${a} minutes and every ${b} minutes. They ring together now — after how many minutes will they ring together again?`, o: opts(L, [a * b, gcd(a, b), L + a]), exp: `They coincide at the LCM of ${a} and ${b}, which is ${L} minutes.` }; },
  () => { const g = ri(3, 12), x = ri(2, 9), y = ri(2, 9); if (gcd(x, y) !== 1) return null; return { wa: `📦 ${g * x} pens and ${g * y} pencils must be packed into identical kits with nothing left over. What is the greatest number of kits?`, o: opts(g, [g * x, g * y, g + 1]), exp: `The greatest number of kits is HCF(${g * x}, ${g * y}) = ${g}.` }; },
  () => { const n = pick([16, 25, 36, 49, 64, 81, 100, 121, 144]); return { wa: `⬜ Is ${n} a perfect square?`, o: yesNo(true, 'Yes', 'No'), exp: `${Math.sqrt(n)} × ${Math.sqrt(n)} = ${n}, so yes.` }; },
];

/* ============================================== exponents, powers and roots === */
const exponents = [
  () => { const b = ri(2, 9), e = ri(2, 4); return { wa: `⬆️ ${b}^${e} = ?`, o: opts(b ** e, [b * e, b ** e + b, b ** (e - 1)]), exp: `${b}^${e} means ${Array(e).fill(b).join(' × ')} = ${fmt(b ** e)}.` }; },
  () => { const b = ri(2, 6), m = ri(2, 4), n = ri(2, 4); return { wa: `✖️ ${b}^${m} × ${b}^${n} = ?`, o: among(`${b}^${m + n}`, [`${b}^${m * n}`, `${b * b}^${m + n}`, `${b}^${Math.abs(m - n)}`]), exp: `Same base, so add the powers: ${b}^${m} × ${b}^${n} = ${b}^${m + n}.` }; },
  () => { const b = ri(2, 6), m = ri(4, 7), n = ri(1, 3); return { wa: `➗ ${b}^${m} ÷ ${b}^${n} = ?`, o: among(`${b}^${m - n}`, [`${b}^${m + n}`, `${b}^${m / n}`, `1^${m - n}`]), exp: `Same base, so subtract the powers: ${b}^${m} ÷ ${b}^${n} = ${b}^${m - n}.` }; },
  () => { const b = ri(2, 5), m = ri(2, 3), n = ri(2, 3); return { wa: `🔁 (${b}^${m})^${n} = ?`, o: among(`${b}^${m * n}`, [`${b}^${m + n}`, `${b}^${m ** n}`, `${b * n}^${m}`]), exp: `A power of a power multiplies: (${b}^${m})^${n} = ${b}^${m * n}.` }; },
  () => { const b = ri(2, 12); return { wa: `0️⃣ What is ${b}^0?`, o: opts(1, [0, b, b + 1]), exp: `Any non-zero number raised to the power 0 is 1 — not 0, and not the number itself.` }; },
  () => { const n = pick([16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225]); return { wa: `√ What is the square root of ${n}?`, o: opts(Math.sqrt(n), near(Math.sqrt(n))), exp: `${Math.sqrt(n)} × ${Math.sqrt(n)} = ${n}, so √${n} = ${Math.sqrt(n)}.` }; },
  () => { const n = pick([8, 27, 64, 125, 216, 343, 512, 729, 1000]); return { wa: `∛ What is the cube root of ${fmt(n)}?`, o: opts(Math.round(Math.cbrt(n)), near(Math.round(Math.cbrt(n)))), exp: `${Math.round(Math.cbrt(n))}³ = ${fmt(n)}, so the cube root is ${Math.round(Math.cbrt(n))}.` }; },
  () => { const b = ri(2, 6), e = ri(1, 3); return { wa: `🔽 Write ${b}^−${e} as a fraction.`, o: among(`1/${b ** e}`, [`−${b ** e}`, `${b ** e}`, `−1/${b ** e}`]), exp: `A negative power means the reciprocal: ${b}^−${e} = 1/${b}^${e} = 1/${b ** e}.` }; },
  () => { const d = ri(1, 9), p = ri(3, 8); const n = d * 10 ** p; return { wa: `🔬 Write ${fmt(n)} in standard form.`, o: among(`${d} × 10^${p}`, [`${d} × 10^${p + 1}`, `${d * 10} × 10^${p}`, `${d} × 10^${p - 1}`]), exp: `Move the decimal point ${p} places: ${fmt(n)} = ${d} × 10^${p}.` }; },
  () => { const b = ri(2, 5), e = ri(2, 4); const wrong = b * e; return { wa: `🔎 ${pick(NAMES)} says ${b}^${e} = ${wrong}. Is that right?`, o: yesNo(b ** e === wrong, 'Yes', 'No — that is multiplication, not a power'), exp: `${b}^${e} means ${b} multiplied by itself ${e} times = ${b ** e}, not ${b} × ${e} = ${wrong}.` }; },
  () => { const a = ri(2, 5), b = ri(2, 5), e = ri(2, 3); return { wa: `✖️ (${a} × ${b})^${e} = ?`, o: among(`${a}^${e} × ${b}^${e}`, [`${a}^${e} + ${b}^${e}`, `${a * b}^${e * e}`, `${a} × ${b}^${e}`]), exp: `The power spreads over both factors: (${a}×${b})^${e} = ${a}^${e} × ${b}^${e} = ${fmt((a * b) ** e)}.` }; },
  () => { const n = ri(2, 20); return { wa: `⬜ What is ${n} squared?`, o: opts(n * n, [n * 2, n * n + n, (n + 1) ** 2]), exp: `${n}² = ${n} × ${n} = ${n * n}.` }; },
  () => { const n = ri(2, 10); return { wa: `🧊 What is ${n} cubed?`, o: opts(n ** 3, [n * 3, n * n, n ** 3 + n]), exp: `${n}³ = ${n} × ${n} × ${n} = ${fmt(n ** 3)}.` }; },
];

/* ================================================================ algebra === */
const algebraBasics = [
  () => { const a = ri(2, 12), b = ri(1, 20), x = ri(2, 12); return { wa: `🔤 If x = ${x}, what is ${a}x ${sgn(b)}?`, o: opts(a * x + b, near(a * x + b)), exp: `Put ${x} in place of x: ${a}×${x} ${sgn(b)} = ${a * x} ${sgn(b)} = ${a * x + b}.` }; },
  () => { const a = ri(2, 9), b = ri(1, 15), x = ri(2, 9); return { wa: `🔤 If x = ${x}, what is ${a}x² ${sgn(b)}?`, o: opts(a * x * x + b, near(a * x * x + b)), exp: `x² = ${x * x}, so ${a}×${x * x} ${sgn(b)} = ${a * x * x + b}.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `🧹 Simplify: ${a}x + ${b}x`, o: among(`${co(a + b)}`, [`${co(a * b)}`, `${co(a + b)}²`, `${co(a - b)}`]), exp: `Like terms add: ${a}x + ${b}x = ${a + b}x.` }; },
  () => { const a = ri(5, 15), b = ri(1, 4); return { wa: `🧹 Simplify: ${co(a, 'y')} − ${co(b, 'y')}`, o: among(`${co(a - b, 'y')}`, [`${co(a + b, 'y')}`, `${a - b}`, `${co(a * b, 'y')}`]), exp: `Like terms subtract: ${co(a, 'y')} − ${co(b, 'y')} = ${co(a - b, 'y')}.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9), c = ri(2, 9); return { wa: `🧹 Simplify: ${a}x + ${b}y + ${c}x`, o: among(`${a + c}x + ${b}y`, [`${a + b + c}xy`, `${a + c}x${b}y`, `${a + b}x + ${c}y`]), exp: `Only the x terms combine: ${a}x + ${c}x = ${a + c}x, and ${b}y stays as it is.` }; },
  () => { const a = ri(2, 9), b = ri(2, 12); return { wa: `📖 Write as an expression: "${b} more than ${a} times a number n".`, o: among(`${a}n + ${b}`, [`${a} + ${b}n`, `${a}n − ${b}`, `${a + b}n`]), exp: `"${a} times a number" is ${a}n, and "${b} more" adds ${b}: ${a}n + ${b}.` }; },
  () => { const a = ri(2, 9), x = ri(2, 12), b = ri(1, 20); return { wa: `🎯 Solve for x:  ${a}x ${sgn(b)} = ${a * x + b}`, o: opts(x, near(x)), exp: `Take ${b < 0 ? 'away' : 'off'} ${Math.abs(b)}: ${a}x = ${a * x}. Then divide by ${a}: x = ${x}.` }; },
  () => { const x = ri(2, 15), b = ri(2, 20); return { wa: `🎯 Solve for x:  x ${sgn(-b)} = ${x - b}`, o: opts(x, near(x)), exp: `Add ${b} to both sides: x = ${x - b} + ${b} = ${x}.` }; },
  () => { const a = ri(2, 9), x = ri(2, 12); return { wa: `🎯 Solve for x:  x/${a} = ${x}`, o: opts(a * x, near(a * x)), exp: `Multiply both sides by ${a}: x = ${a} × ${x} = ${a * x}.` }; },
  () => { const a = ri(3, 9), b = ri(1, 6), x = ri(2, 10); const c = ri(1, a - 1), d = (a - c) * x + b; return { wa: `🎯 Solve for x:  ${co(a)} + ${b} = ${co(c)} + ${d}`, o: opts(x, near(x)), exp: `Bring x terms together: ${co(a - c)} = ${d} − ${b} = ${d - b}. So x = ${x}.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `📦 Expand: ${a}(x + ${b})`, o: among(`${a}x + ${a * b}`, [`${a}x + ${b}`, `${co(a + b)}`, `${a}x + ${a + b}`]), exp: `Multiply both terms by ${a}: ${a}×x + ${a}×${b} = ${a}x + ${a * b}.` }; },
  () => { const n = ri(3, 20), N = pick(NAMES), th = pick(THINGS); const k = ri(2, 5); return { wa: `🧒 ${N} has n ${th}. A friend has ${k} times as many, plus ${n}. Write the friend's count.`, o: among(`${k}n + ${n}`, [`${k + n}n`, `n + ${k}`, `${k}(n + ${n})`]), exp: `"${k} times as many" is ${k}n, then "plus ${n}" gives ${k}n + ${n}.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `🔎 Is ${a}x + ${b}y the same as ${a + b}xy?`, o: yesNo(false, 'Yes', 'No — they are unlike terms'), exp: `x and y are different letters, so ${a}x and ${b}y cannot be combined. They stay as ${a}x + ${b}y.` }; },
  () => { const c = ri(2, 9), x = ri(2, 9), y = ri(2, 9); return { wa: `🔤 If x = ${x} and y = ${y}, what is ${c}xy?`, o: opts(c * x * y, near(c * x * y)), exp: `${c} × ${x} × ${y} = ${c * x * y}.` }; },
];

/* ============================================== simultaneous and quadratics === */
const simultaneous = [
  () => { const x = ri(1, 9), y = ri(1, 9), a = ri(1, 6), b = ri(1, 6), c = ri(1, 6), d = ri(1, 6); if (a * d - b * c === 0) return null; return { wa: `🎯 Solve these together:\n   ${co(a)} + ${co(b, 'y')} = ${a * x + b * y}\n   ${co(c)} + ${co(d, 'y')} = ${c * x + d * y}\nWhat is x?`, o: opts(x, near(x)), exp: `Eliminating y gives x = ${x} (and y = ${y}). Check: ${a}×${x} + ${b}×${y} = ${a * x + b * y}. ✓` }; },
  () => { const x = ri(1, 9), y = ri(1, 9), a = ri(1, 6), b = ri(1, 6), c = ri(1, 6), d = ri(1, 6); if (a * d - b * c === 0) return null; return { wa: `🎯 Solve these together:\n   ${co(a)} + ${co(b, 'y')} = ${a * x + b * y}\n   ${co(c)} + ${co(d, 'y')} = ${c * x + d * y}\nWhat is y?`, o: opts(y, near(y)), exp: `Eliminating x gives y = ${y} (and x = ${x}). Check: ${c}×${x} + ${d}×${y} = ${c * x + d * y}. ✓` }; },
  () => { const x = ri(2, 20), y = ri(2, 20); return { wa: `🔢 Two numbers add to ${x + y} and differ by ${Math.abs(x - y)}. What is the LARGER number?`, o: opts(Math.max(x, y), near(Math.max(x, y))), exp: `Larger = (sum + difference) ÷ 2 = (${x + y} + ${Math.abs(x - y)}) ÷ 2 = ${Math.max(x, y)}.` }; },
  () => { const p = ri(10, 60), q = ri(10, 60), a = ri(2, 5), b = ri(2, 5); return { wa: `🛒 ${a} pens and ${b} books cost ₹${a * p + b * q}. One pen costs ₹${p}. What does one book cost?`, o: opts(q, near(q)), exp: `${a} pens cost ${a}×₹${p} = ₹${a * p}. So ${b} books cost ₹${a * p + b * q} − ₹${a * p} = ₹${b * q}, and one book is ₹${q}.` }; },
  () => { const son = ri(6, 16), father = son + ri(22, 34); return { wa: `👨‍👦 A father and his son are ${father + son} years old together. The father is ${father - son} years older than the son. How old is the SON?`, o: opts(son, near(son)), exp: `Son = (total − difference) ÷ 2 = (${father + son} − ${father - son}) ÷ 2 = ${son} years.` }; },
  () => { const x = ri(1, 9), y = ri(1, 9); return { wa: `🧮 If x + y = ${x + y} and x − y = ${x - y}, what is x?`, o: opts(x, near(x)), exp: `Add the two equations: 2x = ${(x + y) + (x - y)}, so x = ${x}.` }; },
  () => { const r = ri(2, 9); return { wa: `⚖️ If 2x = ${2 * r} and y = x + ${r}, what is y?`, o: opts(2 * r, [r, 3 * r, 2 * r + 1]), exp: `x = ${2 * r} ÷ 2 = ${r}, so y = ${r} + ${r} = ${2 * r}.` }; },
];

const quadratics = [
  () => { const p = ri(1, 9), q = ri(1, 9); return { wa: `🎯 Solve:  x² − ${p + q}x + ${p * q} = 0. What are the roots?`, o: among(`${p} and ${q}`, [`${-p} and ${-q}`, `${p + q} and ${p * q}`, `${p} and ${-q}`]), exp: `Two numbers adding to ${p + q} and multiplying to ${p * q} are ${p} and ${q}, so (x − ${p})(x − ${q}) = 0.` }; },
  () => { const p = ri(1, 9), q = ri(1, 9); return { wa: `🧩 Factorise:  x² + ${p + q}x + ${p * q}`, o: among(`(x + ${p})(x + ${q})`, [`(x − ${p})(x − ${q})`, `(x + ${p + q})(x + ${p * q})`, `(x + ${p})(x − ${q})`]), exp: `${p} + ${q} = ${p + q} and ${p} × ${q} = ${p * q}, so it factors as (x + ${p})(x + ${q}).` }; },
  () => { const a = ri(1, 4), b = ri(-9, 9), c = ri(-9, 9); const D = b * b - 4 * a * c; return { wa: `📐 Find the discriminant of ${co(a, 'x²')} ${sgnCo(b)} ${sgn(c)} = 0.`, o: opts(D, near(D)), exp: `D = b² − 4ac = (${b})² − 4×${a}×${c} = ${b * b} − ${4 * a * c} = ${D}.` }; },
  () => { const a = 1, b = ri(-8, 8), c = ri(-8, 8); const D = b * b - 4 * c; const kind = D > 0 ? 'Two different real roots' : D === 0 ? 'Two equal real roots' : 'No real roots'; return { wa: `🔍 How many real roots does x² ${sgnCo(b)} ${sgn(c)} = 0 have?`, o: among(kind, ['Two different real roots', 'Two equal real roots', 'No real roots'].filter((k) => k !== kind)), exp: `D = ${b * b} − 4×${c} = ${D}, which is ${D > 0 ? 'positive' : D === 0 ? 'zero' : 'negative'} — so ${kind.toLowerCase()}.` }; },
  () => { const p = ri(1, 9), q = ri(1, 9); return { wa: `➕ The roots of x² − ${p + q}x + ${p * q} = 0 add up to?`, o: opts(p + q, near(p + q)), exp: `Sum of roots = −b/a = ${p + q}. (The roots are ${p} and ${q}.)` }; },
  () => { const p = ri(1, 9), q = ri(1, 9); return { wa: `✖️ The roots of x² − ${p + q}x + ${p * q} = 0 multiply to?`, o: opts(p * q, near(p * q)), exp: `Product of roots = c/a = ${p * q}. (The roots are ${p} and ${q}.)` }; },
  () => { const r = ri(2, 12); return { wa: `🎯 Solve:  x² = ${r * r}. What are the values of x?`, o: among(`${r} and −${r}`, [`only ${r}`, `${r * r} and −${r * r}`, `only −${r}`]), exp: `Both ${r}² and (−${r})² equal ${r * r}, so x = ±${r}.` }; },
  () => { const p = ri(2, 9); return { wa: `🧩 Factorise:  x² − ${p * p}`, o: among(`(x + ${p})(x − ${p})`, [`(x − ${p})²`, `(x + ${p})²`, `(x + ${p * p})(x − 1)`]), exp: `This is a difference of two squares: x² − ${p}² = (x + ${p})(x − ${p}).` }; },
  () => { const l = ri(3, 15), w = ri(2, l - 1); return { wa: `📏 A rectangle's length is ${l - w} m more than its width and its area is ${l * w} m². What is the width?`, o: opts(w, near(w)), exp: `Width × (width + ${l - w}) = ${l * w}. Trying ${w}: ${w} × ${l} = ${l * w} ✓, so the width is ${w} m.` }; },
];

const polynomials = [
  () => { const a = ri(1, 6), b = ri(1, 9), c = ri(1, 9), x = ri(1, 5); const v = a * x * x + b * x + c; return { wa: `🔤 If p(x) = ${co(a, 'x²')} + ${co(b)} + ${c}, find p(${x}).`, o: opts(v, near(v)), exp: `${a}×${x * x} + ${b}×${x} + ${c} = ${a * x * x} + ${b * x} + ${c} = ${v}.` }; },
  () => { const a = ri(1, 6), b = ri(1, 9), d = ri(2, 4); return { wa: `📊 What is the degree of the polynomial ${co(a, `x^${d}`)} + ${co(b)} + 7?`, o: opts(d, [d + 1, d - 1, a]), exp: `The degree is the highest power of x, which is ${d}.` }; },
  () => { const r = ri(1, 9); return { wa: `🎯 Find the zero of the polynomial p(x) = x − ${r}.`, o: opts(r, [-r, 0, r + 1]), exp: `Set x − ${r} = 0, so x = ${r}.` }; },
  () => { const a = ri(2, 6), r = ri(1, 9); return { wa: `🎯 Find the zero of p(x) = ${a}x − ${a * r}.`, o: opts(r, near(r)), exp: `${a}x = ${a * r}, so x = ${r}.` }; },
  () => { const a = ri(1, 5), b = ri(1, 9), c = ri(1, 9), k = ri(1, 4); const v = a * k * k + b * k + c; return { wa: `➗ What is the remainder when ${co(a, 'x²')} + ${co(b)} + ${c} is divided by (x − ${k})?`, o: opts(v, near(v)), exp: `By the Remainder Theorem the remainder is p(${k}) = ${a * k * k} + ${b * k} + ${c} = ${v}.` }; },
  () => { const p = ri(1, 8), q = ri(1, 8); return { wa: `➕ The zeroes of x² − ${p + q}x + ${p * q} are ${p} and ${q}. What is their sum?`, o: opts(p + q, near(p + q)), exp: `${p} + ${q} = ${p + q}, which matches −b/a.` }; },
  () => { const a = ri(1, 5), b = ri(1, 9); return { wa: `🧹 Add:  (${co(a, 'x²')} + ${co(b)}) + (${co(a, 'x²')} − ${co(b)})`, o: among(`${co(2 * a, 'x²')}`, [`${co(2 * a, 'x²')} + ${co(2 * b)}`, `${co(a, 'x²')}`, `${co(2 * a, 'x⁴')}`]), exp: `The x terms cancel: ${co(b)} − ${co(b)} = 0, leaving ${co(a, 'x²')} + ${co(a, 'x²')} = ${co(2 * a, 'x²')}.` }; },
  () => { const k = ri(1, 6), a = ri(1, 5); const val = a * k * k * k; return { wa: `🔍 Is x = ${k} a zero of p(x) = ${co(a, 'x³')} − ${val}?`, o: yesNo(true, 'Yes', 'No'), exp: `p(${k}) = ${a}×${k ** 3} − ${val} = ${val} − ${val} = 0, so yes.` }; },
  () => { const d = pick([['linear', 1], ['quadratic', 2], ['cubic', 3]]); return { wa: `🏷️ What is a polynomial of degree ${d[1]} called?`, o: among(d[0], ['linear', 'quadratic', 'cubic', 'constant'].filter((x) => x !== d[0])), exp: `Degree ${d[1]} polynomials are called ${d[0]}.` }; },
];

const factorisation = [
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `🧩 Factorise:  ${a * b}x + ${a * b * b}`, o: among(`${a * b}(x + ${b})`, [`${a}(x + ${b})`, `${a * b}(x + ${a})`, `${b}(x + ${a * b})`]), exp: `Both terms share ${a * b}: ${a * b}x + ${a * b * b} = ${a * b}(x + ${b}).` }; },
  () => { const p = ri(2, 9); return { wa: `🧩 Factorise:  x² − ${p * p}`, o: among(`(x + ${p})(x − ${p})`, [`(x − ${p})²`, `(x + ${p})²`, `x(x − ${p * p})`]), exp: `Difference of squares: x² − ${p}² = (x + ${p})(x − ${p}).` }; },
  () => { const p = ri(1, 9), q = ri(1, 9); return { wa: `🧩 Factorise:  x² + ${p + q}x + ${p * q}`, o: among(`(x + ${p})(x + ${q})`, [`(x − ${p})(x − ${q})`, `(x + ${p * q})(x + ${p + q})`, `(x + ${p})(x − ${q})`]), exp: `Find two numbers with sum ${p + q} and product ${p * q}: they are ${p} and ${q}.` }; },
  () => { const p = ri(1, 9), q = ri(1, 9); if (p === q) return null; return { wa: `🧩 Factorise:  x² − ${p + q}x + ${p * q}`, o: among(`(x − ${p})(x − ${q})`, [`(x + ${p})(x + ${q})`, `(x − ${p})(x + ${q})`, `(x − ${p * q})(x − 1)`]), exp: `Two numbers with sum ${p + q} and product ${p * q}, both negative in the brackets: ${p} and ${q}.` }; },
  () => { const a = ri(2, 8); return { wa: `🧩 Factorise:  x² + ${2 * a}x + ${a * a}`, o: among(`(x + ${a})²`, [`(x − ${a})²`, `(x + ${a})(x − ${a})`, `(x + ${2 * a})²`]), exp: `This is a perfect square: x² + 2×${a}x + ${a}² = (x + ${a})².` }; },
  () => { const a = ri(2, 8); return { wa: `🧩 Factorise:  x² − ${2 * a}x + ${a * a}`, o: among(`(x − ${a})²`, [`(x + ${a})²`, `(x − ${a})(x + ${a})`, `(x − ${2 * a})²`]), exp: `A perfect square: x² − 2×${a}x + ${a}² = (x − ${a})².` }; },
  () => { const a = ri(2, 6), b = ri(2, 6); return { wa: `📦 Expand:  (x + ${a})(x + ${b})`, o: among(`x² + ${a + b}x + ${a * b}`, [`x² + ${a * b}x + ${a + b}`, `x² + ${a + b}x + ${a + b}`, `x² + ${a}x + ${b}`]), exp: `Multiply out: x² + ${b}x + ${a}x + ${a * b} = x² + ${a + b}x + ${a * b}.` }; },
  () => { const a = ri(2, 9); return { wa: `📦 Expand:  (x + ${a})²`, o: among(`x² + ${2 * a}x + ${a * a}`, [`x² + ${a * a}`, `x² + ${a}x + ${a * a}`, `x² + ${2 * a}x + ${2 * a}`]), exp: `(x + ${a})² = x² + 2×${a}×x + ${a}² = x² + ${2 * a}x + ${a * a}.` }; },
  () => { const a = ri(2, 9); return { wa: `📦 Expand:  (x − ${a})²`, o: among(`x² − ${2 * a}x + ${a * a}`, [`x² − ${a * a}`, `x² − ${2 * a}x − ${a * a}`, `x² + ${2 * a}x + ${a * a}`]), exp: `(x − ${a})² = x² − 2×${a}×x + ${a}² = x² − ${2 * a}x + ${a * a}.` }; },
  () => { const a = ri(2, 9); return { wa: `📦 Expand:  (x + ${a})(x − ${a})`, o: among(`x² − ${a * a}`, [`x² + ${a * a}`, `(x + ${a})²`, `x² − ${2 * a}x + ${a * a}`]), exp: `The middle terms cancel, leaving x² − ${a}² = x² − ${a * a}.` }; },
  () => { const s = ri(2, 12), p = ri(2, 30); return { wa: `🔢 If a + b = ${s} and ab = ${p}, what is a² + b²?`, o: opts(s * s - 2 * p, near(s * s - 2 * p)), exp: `a² + b² = (a+b)² − 2ab = ${s * s} − ${2 * p} = ${s * s - 2 * p}.` }; },
  () => { const d = ri(2, 12), p = ri(2, 30); return { wa: `🔢 If a − b = ${d} and ab = ${p}, what is a² + b²?`, o: opts(d * d + 2 * p, near(d * d + 2 * p)), exp: `a² + b² = (a−b)² + 2ab = ${d * d} + ${2 * p} = ${d * d + 2 * p}.` }; },
  () => { const a = ri(11, 30); return { wa: `🧠 Use an identity to work out ${a}² quickly.`, o: opts(a * a, near(a * a)), exp: `Write ${a} as ${a - 1} + 1: (${a - 1} + 1)² = ${(a - 1) ** 2} + ${2 * (a - 1)} + 1 = ${a * a}.` }; },
  () => { const a = ri(11, 40); return { wa: `🧠 Use the difference of squares to find ${a + 1} × ${a - 1}.`, o: opts(a * a - 1, near(a * a - 1)), exp: `(${a}+1)(${a}−1) = ${a}² − 1 = ${a * a} − 1 = ${a * a - 1}.` }; },
  () => { const a = ri(2, 8), b = ri(2, 8); return { wa: `🔍 Which identity gives (a + b)²?`, o: among('a² + 2ab + b²', ['a² + b²', 'a² − 2ab + b²', 'a² + ab + b²']), exp: `(a + b)² = a² + 2ab + b² — the middle term 2ab is the one most often forgotten.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `🧩 Factorise by grouping:  x² + ${a}x + ${b}x + ${a * b}`, o: among(`(x + ${a})(x + ${b})`, [`(x + ${a + b})(x + ${a * b})`, `(x − ${a})(x − ${b})`, `x(x + ${a + b})`]), exp: `Group them: x(x + ${a}) + ${b}(x + ${a}) = (x + ${a})(x + ${b}).` }; },
  () => { const a = ri(2, 6), b = ri(2, 6); return { wa: `📦 Expand:  (${a}x + ${b})²`, o: among(`${a * a}x² + ${2 * a * b}x + ${b * b}`, [`${a * a}x² + ${b * b}`, `${a * a}x² + ${a * b}x + ${b * b}`, `${a}x² + ${2 * a * b}x + ${b}`]), exp: `(${a}x + ${b})² = (${a}x)² + 2×${a}x×${b} + ${b}² = ${a * a}x² + ${2 * a * b}x + ${b * b}.` }; },
  () => { const a = ri(2, 9); return { wa: `🔎 Is x² + ${a * a} the same as (x + ${a})²?`, o: yesNo(false, 'Yes', 'No'), exp: `(x + ${a})² = x² + ${2 * a}x + ${a * a}. The middle term ${2 * a}x is missing, so they are not the same.` }; },
  () => { const a = ri(2, 8); return { wa: `🧩 Factorise:  ${a}x² − ${a}`, o: among(`${a}(x + 1)(x − 1)`, [`${a}(x² − 1)²`, `(x + ${a})(x − ${a})`, `${a}(x − 1)²`]), exp: `Take out ${a} first: ${a}(x² − 1), and x² − 1 = (x + 1)(x − 1).` }; },
];

const inequations = [
  () => { const a = ri(2, 9), b = ri(1, 20), k = ri(2, 12); return { wa: `📐 Solve:  ${a}x ${sgn(b)} > ${a * k + b}`, o: among(`x > ${k}`, [`x < ${k}`, `x > ${a * k}`, `x ≥ ${k}`]), exp: `Take away ${b}: ${a}x > ${a * k}. Divide by ${a} (positive, so the sign stays): x > ${k}.` }; },
  () => { const a = ri(2, 9), k = ri(2, 12); return { wa: `📐 Solve:  ${a}x ≤ ${a * k}`, o: among(`x ≤ ${k}`, [`x ≥ ${k}`, `x < ${k}`, `x ≤ ${a * k}`]), exp: `Divide both sides by ${a}: x ≤ ${k}.` }; },
  () => { const a = ri(2, 9), k = ri(2, 12); return { wa: `⚠️ Solve:  −${a}x > ${a * k}`, o: among(`x < −${k}`, [`x > −${k}`, `x < ${k}`, `x > ${k}`]), exp: `Dividing by a NEGATIVE number flips the sign: x < −${k}.` }; },
  // The list is written out when it is short. "1, 2, ... , 2" is what an
  // ellipsis template produces when the range is tiny, and it reads as a typo.
  () => { const k = ri(3, 10); const n = k - 1;
    const list = n <= 5 ? Array.from({ length: n }, (_, i) => i + 1).join(', ')
                        : `1, 2, 3, … , ${n}`;
    return { wa: `🔢 x is a natural number and x < ${k}. How many values can x take?`, o: opts(n, [k, k + 1, n - 1]), exp: `x can be ${list} — that is ${n} value${n === 1 ? '' : 's'}.` }; },
  () => { const k = ri(2, 9); return { wa: `🔢 What is the SMALLEST integer satisfying x > ${k}?`, o: opts(k + 1, [k, k + 2, k - 1]), exp: `x must be strictly bigger than ${k}, so the smallest integer is ${k + 1}.` }; },
  () => { const a = ri(2, 6), b = ri(1, 10), k = ri(2, 9); return { wa: `📐 Solve:  ${a}x ${sgn(-b)} < ${a * k - b}`, o: among(`x < ${k}`, [`x > ${k}`, `x ≤ ${k}`, `x < ${a * k}`]), exp: `Add ${b}: ${a}x < ${a * k}. Divide by ${a}: x < ${k}.` }; },
  () => { const lo = ri(1, 6), hi = lo + ri(2, 6); return { wa: `📊 How many integers satisfy ${lo} ≤ x ≤ ${hi}?`, o: opts(hi - lo + 1, [hi - lo, hi - lo + 2, hi]), exp: `From ${lo} to ${hi} inclusive is ${hi} − ${lo} + 1 = ${hi - lo + 1} integers.` }; },
  () => { const k = ri(3, 12); return { wa: `🔢 What is the LARGEST integer satisfying x < ${k}?`, o: opts(k - 1, [k, k + 1, k - 2]), exp: `x must be strictly less than ${k}, so the largest integer is ${k - 1}.` }; },
  () => { const k = ri(2, 10); return { wa: `📋 List the natural numbers satisfying x ≤ ${k}. How many are there?`, o: opts(k, [k - 1, k + 1, 2 * k]), exp: `Natural numbers start at 1, so x can be 1 up to ${k} — that is ${k} values.` }; },
  () => { const a = ri(2, 6), b = ri(1, 12), k = ri(2, 9); return { wa: `🎒 A bag holds x books. ${a} such bags plus ${b} more books come to fewer than ${a * k + b} books. What is the largest whole number x can be?`, o: opts(k - 1, [k, k + 1, a * k]), exp: `${a}x + ${b} < ${a * k + b}, so ${a}x < ${a * k} and x < ${k}. The largest whole number is ${k - 1}.` }; },
  () => { const k = ri(2, 9); return { wa: `⚠️ When you multiply BOTH sides of x > ${k} by −1, what happens?`, o: among(`It becomes −x < −${k}`, [`It becomes −x > −${k}`, `Nothing changes`, `It becomes x < ${k}`]), exp: `Multiplying or dividing an inequality by a negative number reverses the sign, giving −x < −${k}.` }; },
  () => { const k = ri(2, 9); return { wa: `📐 Solve:  x + ${k} ≥ ${2 * k}`, o: among(`x ≥ ${k}`, [`x ≤ ${k}`, `x > ${k}`, `x ≥ ${2 * k}`]), exp: `Take ${k} from both sides: x ≥ ${2 * k} − ${k} = ${k}.` }; },
];

/* =============================================================== sets === */
const sets = [
  () => { const both = ri(5, 25), onlyA = ri(5, 35), onlyB = ri(5, 35); const total = both + onlyA + onlyB; const [s1, s2] = pick(H.SPORTS); return { wa: `🏫 In a class of ${total} students, ${onlyA + both} play ${s1} and ${onlyB + both} play ${s2}. Every student plays at least one. How many play BOTH?`, o: opts(both, near(both)), exp: `n(A∪B) = n(A) + n(B) − n(A∩B). So ${total} = ${onlyA + both} + ${onlyB + both} − both, giving both = ${both}.` }; },
  () => { const a = ri(10, 40), b = ri(10, 40), both = ri(2, Math.min(a, b) - 1); return { wa: `➕ If n(A) = ${a}, n(B) = ${b} and n(A ∩ B) = ${both}, find n(A ∪ B).`, o: opts(a + b - both, near(a + b - both)), exp: `n(A∪B) = ${a} + ${b} − ${both} = ${a + b - both}.` }; },
  // The overlap is chosen first and kept at 2 or more, so the answer is never
  // 0 or 1 — those force meaningless negative distractors.
  () => { const both = ri(2, 15), a = ri(both + 5, 40), b = ri(both + 5, 40); const un = a + b - both; return { wa: `✖️ If n(A) = ${a}, n(B) = ${b} and n(A ∪ B) = ${un}, find n(A ∩ B).`, o: opts(both, near(both)), exp: `n(A∩B) = n(A) + n(B) − n(A∪B) = ${a} + ${b} − ${un} = ${both}.` }; },
  () => { const A = [...new Set(Array.from({ length: 3 }, () => ri(1, 9)))].sort((x, y) => x - y); const B = [...new Set(Array.from({ length: 3 }, () => ri(1, 9)))].sort((x, y) => x - y); const U = [...new Set([...A, ...B])].sort((x, y) => x - y); return { wa: `🔗 If A = {${A}} and B = {${B}}, find A ∪ B.`, o: among(`{${U}}`, [`{${A.filter((x) => B.includes(x))}}`, `{${A}}`, `{${B}}`]), exp: `The union collects every element from both sets, listed once: {${U}}.` }; },
  () => { const shared = ri(1, 5); const A = [...new Set([shared, ri(1, 9), ri(1, 9)])].sort((x, y) => x - y); const B = [...new Set([shared, ri(1, 9), ri(1, 9)])].sort((x, y) => x - y); const I = A.filter((x) => B.includes(x)); return { wa: `🔗 If A = {${A}} and B = {${B}}, find A ∩ B.`, o: among(`{${I}}`, [`{${[...new Set([...A, ...B])].sort((x, y) => x - y)}}`, `{${A}}`, '{ } (empty set)']), exp: `The intersection keeps only what appears in BOTH sets: {${I}}.` }; },
  () => { const n = ri(2, 5); return { wa: `🔢 A set has ${n} elements. How many subsets does it have?`, o: opts(2 ** n, [n * 2, 2 ** n - 1, n ** 2]), exp: `A set with ${n} elements has 2^${n} = ${2 ** n} subsets.` }; },
  () => { const A = [...new Set(Array.from({ length: 4 }, () => ri(1, 20)))]; return { wa: `🧮 What is the cardinal number of the set {${A.sort((x, y) => x - y)}}?`, o: opts(A.length, [A.length + 1, A.length - 1, Math.max(...A)]), exp: `Cardinal number means how many elements — there are ${A.length}.` }; },
  () => { const U = ri(30, 60), a = ri(5, 25); return { wa: `🌐 The universal set has ${U} elements and n(A) = ${a}. Find n(A′), the complement.`, o: opts(U - a, near(U - a)), exp: `The complement holds everything not in A: ${U} − ${a} = ${U - a}.` }; },
  () => { const both = ri(3, 15), onlyA = ri(3, 20), onlyB = ri(3, 20), none = ri(2, 10); const total = both + onlyA + onlyB + none; const [s1, s2] = pick(H.SPORTS); return { wa: `🏫 Of ${total} students, ${onlyA + both} like ${s1}, ${onlyB + both} like ${s2} and ${both} like both. How many like NEITHER?`, o: opts(none, near(none)), exp: `Liking at least one = ${onlyA + both} + ${onlyB + both} − ${both} = ${onlyA + onlyB + both}. So ${total} − ${onlyA + onlyB + both} = ${none} like neither.` }; },
  () => { const both = ri(4, 15), onlyA = ri(4, 20), onlyB = ri(4, 20); const [s1, s2] = pick(H.SPORTS); return { wa: `🎯 ${onlyA + both} students like ${s1}, ${both} like both ${s1} and ${s2}. How many like ${s1} ONLY?`, o: opts(onlyA, near(onlyA)), exp: `Only ${s1} = ${onlyA + both} − ${both} = ${onlyA}.` }; },
  () => { const set = pick([['{1, 2, 3}', 'finite'], ['{natural numbers}', 'infinite'], ['{ }', 'finite'], ['{multiples of 5}', 'infinite']]); return { wa: `♾️ Is the set ${set[0]} finite or infinite?`, o: among(set[1], [set[1] === 'finite' ? 'infinite' : 'finite', 'both', 'neither']), exp: `${set[0]} is ${set[1]} because you ${set[1] === 'finite' ? 'can' : 'cannot'} count all its elements.` }; },
];

/* =========================================== percentage and commercial maths === */
const percentage = [
  () => { const p = pick([5, 10, 12, 15, 20, 25, 40, 50, 60, 75]), n = ri(2, 40) * 20; return { wa: `💯 What is ${p}% of ${fmt(n)}?`, o: opts(round2((n * p) / 100), near(round2((n * p) / 100))), exp: `${p}% of ${fmt(n)} = ${p}/100 × ${fmt(n)} = ${round2((n * p) / 100)}.` }; },
  () => { const part = ri(2, 20), whole = part * pick([2, 4, 5, 10]); return { wa: `📊 ${part} out of ${whole} — what percentage is that?`, o: opts(round2((part / whole) * 100) + '%', [round2((whole / part) * 100) + '%', part + '%', round2((part / whole) * 100 + 10) + '%']), exp: `${part}/${whole} × 100 = ${round2((part / whole) * 100)}%.` }; },
  () => { const p = pick([10, 20, 25, 50]), res = ri(5, 60); const n = (res * 100) / p; return { wa: `🔍 ${p}% of a number is ${res}. What is the number?`, o: opts(n, near(n)), exp: `If ${p}% is ${res}, then 100% is ${res} × 100 ÷ ${p} = ${n}.` }; },
  () => { const cp = ri(2, 40) * 25, p = pick([10, 20, 25, 50]); const sp = cp + (cp * p) / 100; return { wa: `📈 An item bought for ₹${fmt(cp)} is sold at ${p}% profit. What is the selling price?`, o: opts(sp, near(sp)), exp: `Profit = ${p}% of ₹${fmt(cp)} = ₹${(cp * p) / 100}. SP = ₹${fmt(cp)} + ₹${(cp * p) / 100} = ₹${fmt(sp)}.` }; },
  () => { const cp = ri(2, 40) * 25, p = pick([10, 20, 25, 40]); const sp = cp - (cp * p) / 100; return { wa: `📉 An item bought for ₹${fmt(cp)} is sold at ${p}% loss. What is the selling price?`, o: opts(sp, near(sp)), exp: `Loss = ${p}% of ₹${fmt(cp)} = ₹${(cp * p) / 100}. SP = ₹${fmt(cp)} − ₹${(cp * p) / 100} = ₹${fmt(sp)}.` }; },
  () => { const cp = ri(4, 60) * 25, gain = ri(1, 10) * 10; const sp = cp + gain; return { wa: `💹 Cost price ₹${fmt(cp)}, selling price ₹${fmt(sp)}. What is the profit percentage?`, o: opts(round2((gain / cp) * 100) + '%', [round2((gain / sp) * 100) + '%', gain + '%', round2((gain / cp) * 100 + 5) + '%']), exp: `Profit = ₹${gain}. Profit% = ${gain}/${fmt(cp)} × 100 = ${round2((gain / cp) * 100)}%.` }; },
  () => { const mp = ri(4, 40) * 50, d = pick([10, 20, 25]); const sp = mp - (mp * d) / 100; return { wa: `🏷️ A shirt marked ₹${fmt(mp)} is sold at ${d}% discount. What does the customer pay?`, o: opts(sp, near(sp)), exp: `Discount = ${d}% of ₹${fmt(mp)} = ₹${(mp * d) / 100}. Paid = ₹${fmt(mp)} − ₹${(mp * d) / 100} = ₹${fmt(sp)}.` }; },
  () => { const P = ri(2, 40) * 500, R = pick([4, 5, 6, 8, 10]), T = ri(1, 5); const SI = (P * R * T) / 100; return { wa: `🏦 Find the simple interest on ₹${fmt(P)} at ${R}% per year for ${T} year(s).`, o: opts(SI, near(SI)), exp: `SI = P×R×T/100 = ${fmt(P)}×${R}×${T}/100 = ₹${fmt(SI)}.` }; },
  () => { const P = ri(2, 20) * 500, R = pick([4, 5, 10]), T = ri(2, 4); const SI = (P * R * T) / 100; return { wa: `🏦 ₹${fmt(P)} is invested at ${R}% simple interest for ${T} years. What is the total amount returned?`, o: opts(P + SI, near(P + SI)), exp: `SI = ₹${fmt(SI)}. Amount = principal + interest = ₹${fmt(P)} + ₹${fmt(SI)} = ₹${fmt(P + SI)}.` }; },
  () => { const P = ri(2, 20) * 1000, R = pick([10, 20]); const A = P * (1 + R / 100) ** 2; return { wa: `📈 Find the compound interest on ₹${fmt(P)} at ${R}% per year for 2 years.`, o: opts(round2(A - P), near(round2(A - P))), exp: `Amount = ${fmt(P)}×(1 + ${R}/100)² = ₹${fmt(round2(A))}. CI = ₹${fmt(round2(A))} − ₹${fmt(P)} = ₹${fmt(round2(A - P))}.` }; },
  () => { const n = ri(20, 80) * 5, p = pick([10, 20, 25]); const inc = n + (n * p) / 100; return { wa: `📊 A town's population of ${fmt(n)} rises by ${p}%. What is the new population?`, o: opts(inc, near(inc)), exp: `Increase = ${p}% of ${fmt(n)} = ${(n * p) / 100}. New = ${fmt(n)} + ${(n * p) / 100} = ${fmt(inc)}.` }; },
  () => { const total = ri(10, 50) * 10, got = ri(3, 9) * 10; return { wa: `📝 ${pick(NAMES)} scored ${got} out of ${total} in a test. What percentage is that?`, o: opts(round2((got / total) * 100) + '%', [round2((total / got) * 100) + '%', got + '%', round2((got / total) * 100 + 5) + '%']), exp: `${got}/${total} × 100 = ${round2((got / total) * 100)}%.` }; },
];

const ratio = [
  () => { const a = ri(2, 12), b = ri(2, 12), k = ri(2, 9); return { wa: `⚖️ Simplify the ratio ${a * k} : ${b * k}`, o: among(`${a / gcd(a, b)} : ${b / gcd(a, b)}`, [`${a * k} : ${b}`, `${a} : ${b * k}`, `${a + b} : ${k}`]), exp: `Divide both parts by their HCF ${gcd(a * k, b * k)}: ${a * k}:${b * k} = ${a / gcd(a, b)}:${b / gcd(a, b)}.` }; },
  () => { const a = ri(2, 7), b = ri(2, 7), k = ri(3, 20); const total = (a + b) * k; return { wa: `➗ Divide ₹${fmt(total)} between two friends in the ratio ${a} : ${b}. What is the LARGER share?`, o: opts(Math.max(a, b) * k, near(Math.max(a, b) * k)), exp: `Total parts = ${a} + ${b} = ${a + b}. One part = ₹${fmt(total)} ÷ ${a + b} = ₹${k}. Larger share = ${Math.max(a, b)} × ₹${k} = ₹${fmt(Math.max(a, b) * k)}.` }; },
  // a and b must DIFFER. A ratio like 5 : 5 is just 1 : 1, so the answer is
  // whatever c was and the child learns nothing about proportion.
  () => { const a = ri(2, 9), b = ri(2, 9), c = ri(2, 9); if (a === b) return null; const d = (b * c) / a; if (!Number.isInteger(d) || d === c) return null; return { wa: `🔗 If ${a} : ${b} = ${c} : ⬜, what goes in the box?`, o: opts(d, near(d)), exp: `Cross-multiply: ${a} × ⬜ = ${b} × ${c} = ${b * c}, so ⬜ = ${d}.` }; },
  () => { const n = ri(2, 8), cost = ri(5, 40); return { wa: `🛒 If ${n} pens cost ₹${n * cost}, what do ${n * 3} pens cost?`, o: opts(n * 3 * cost, near(n * 3 * cost)), exp: `One pen costs ₹${cost}, so ${n * 3} pens cost ${n * 3} × ₹${cost} = ₹${fmt(n * 3 * cost)}.` }; },
  () => { const w = ri(2, 8), d = ri(2, 12); return { wa: `👷 ${w} workers finish a job in ${w * d} days. How long would ${w * 2} workers take?`, o: opts((w * d) / 2, near((w * d) / 2)), exp: `Twice the workers means half the time: ${w * d} ÷ 2 = ${(w * d) / 2} days.` }; },
  () => { const a = ri(2, 8), b = ri(2, 8); return { wa: `📐 Are ${a} : ${b} and ${a * 3} : ${b * 3} in proportion?`, o: yesNo(true, 'Yes', 'No'), exp: `${a * 3}:${b * 3} simplifies to ${a}:${b}, so yes — they are in proportion.` }; },
  () => { const speed = ri(20, 80), t = ri(2, 8); return { wa: `🚗 A car travels ${fmt(speed * t)} km in ${t} hours. What is its speed?`, o: opts(speed + ' km/h', [speed * t + ' km/h', round2(speed / t) + ' km/h', speed + t + ' km/h']), exp: `Speed = distance ÷ time = ${fmt(speed * t)} ÷ ${t} = ${speed} km/h.` }; },
  () => { const a = ri(2, 9), k = ri(2, 6); const b = a * k, c = b * k; return { wa: `🔗 If ${a} : ${b} = ${b} : x, what is x?`, o: opts(c, near(c)), exp: `Cross-multiply: ${a} × x = ${b}² = ${b * b}, so x = ${b * b} ÷ ${a} = ${c}.` }; },
  () => { const boys = ri(2, 8), girls = ri(2, 8), k = ri(3, 8); return { wa: `👥 Boys and girls in a class are in the ratio ${boys} : ${girls}. If there are ${boys * k} boys, how many girls?`, o: opts(girls * k, near(girls * k)), exp: `${boys * k} boys means one part is ${k}, so girls = ${girls} × ${k} = ${girls * k}.` }; },
];

/* ======================================================== number systems === */
const numberSystems = [
  () => { const n = pick([2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15]); return { wa: `🔢 Is √${n} rational or irrational?`, o: among('Irrational', ['Rational', 'Both', 'Neither']), exp: `${n} is not a perfect square, so √${n} cannot be written as a fraction — it is irrational.` }; },
  () => { const n = pick([4, 9, 16, 25, 36, 49, 64, 81, 100]); return { wa: `🔢 Is √${n} rational or irrational?`, o: among('Rational', ['Irrational', 'Both', 'Neither']), exp: `√${n} = ${Math.sqrt(n)}, a whole number, so it is rational.` }; },
  () => { const a = ri(1, 9), b = ri(2, 9); return { wa: `📏 Is ${a}/${b} a rational number?`, o: yesNo(true, 'Yes', 'No'), exp: `Any number written as one integer over another (with a non-zero bottom) is rational, so yes.` }; },
  () => { const d = pick([2, 4, 5, 8, 10, 16, 20, 25]); const a = ri(1, d - 1); return { wa: `🔄 Does ${a}/${d} give a terminating decimal?`, o: yesNo(true, 'Yes', 'No'), exp: `${d} has only 2s and 5s as prime factors, so ${a}/${d} = ${round2(a / d)} terminates.` }; },
  () => { const d = pick([3, 6, 7, 9, 11, 13]); const a = ri(1, d - 1); return { wa: `🔄 Does ${a}/${d} give a terminating decimal?`, o: yesNo(false, 'Yes', 'No — it repeats'), exp: `${d} has a prime factor other than 2 or 5, so ${a}/${d} is a repeating decimal.` }; },
  () => { const a = ri(2, 20), b = ri(2, 20); return { wa: `➕ Is the sum of two rational numbers always rational?`, o: yesNo(true, 'Yes, always', 'No, sometimes irrational'), exp: `${a} + ${b} = ${a + b} — adding two fractions always gives another fraction, so yes.` }; },
  () => { const n = ri(2, 40); return { wa: `🌐 Is ${n} a natural number, a whole number, and an integer?`, o: among('All three', ['Only a natural number', 'Only an integer', 'Only a whole number']), exp: `${n} is positive and has no fraction part, so it belongs to all three sets.` }; },
  () => { const n = ri(-40, -1); return { wa: `🌐 Is ${n} a natural number?`, o: yesNo(false, 'Yes', 'No — natural numbers start at 1'), exp: `Natural numbers are 1, 2, 3, ... ${n} is negative, so it is an integer but not a natural number.` }; },
  () => { const a = ri(2, 9), b = ri(2, 9); return { wa: `📊 Find a rational number lying between ${a}/${b + 2} and ${a}/${b}.`, o: among(`the average of the two`, ['their product', 'their difference', 'there is none']), exp: `Between any two rational numbers there are infinitely many. The simplest to find is their average.` }; },
  () => { const p = pick([2, 3, 5, 7]); return { wa: `➕ Is 2 + √${p} rational or irrational?`, o: among('Irrational', ['Rational', 'Both', 'Depends on the value']), exp: `√${p} is irrational, and a rational plus an irrational is always irrational.` }; },
];

/* ================================================== speed, distance, time === */
/**
 * Its own family, not a slice of `ratio`.
 *
 * Mapping this chapter onto generic ratio shapes put questions like
 * "simplify 6 : 28" inside a chapter called Speed, Distance and Time — so a
 * parent reading the chapter breakdown in the report was told their child had
 * been practising something they had not.
 */
const speedDistanceTime = [
  () => { const s = ri(20, 90), t = ri(2, 8); return { wa: `🚗 A car covers ${fmt(s * t)} km in ${t} hours. What is its speed?`, o: opts(s + ' km/h', [s * t + ' km/h', round2(s / t) + ' km/h', (s + t) + ' km/h']), exp: `Speed = distance ÷ time = ${fmt(s * t)} ÷ ${t} = ${s} km/h.` }; },
  () => { const s = ri(20, 90), t = ri(2, 9); return { wa: `🛣️ A bus travels at ${s} km/h for ${t} hours. How far does it go?`, o: opts(fmt(s * t) + ' km', [fmt(s + t) + ' km', round2(s / t) + ' km', fmt(s * t + s) + ' km']), exp: `Distance = speed × time = ${s} × ${t} = ${fmt(s * t)} km.` }; },
  () => { const s = ri(20, 80), t = ri(2, 9); return { wa: `⏱️ How long does a ${fmt(s * t)} km journey take at ${s} km/h?`, o: opts(t + ' hours', [fmt(s * t) + ' hours', round2(t / 2) + ' hours', (t + 1) + ' hours']), exp: `Time = distance ÷ speed = ${fmt(s * t)} ÷ ${s} = ${t} hours.` }; },
  () => { const m = ri(2, 20) * 5; const kmh = round2((m * 18) / 5); return { wa: `🔄 Convert ${m} m/s into km/h.`, o: opts(kmh + ' km/h', [round2(m * 5 / 18) + ' km/h', (m * 10) + ' km/h', round2(kmh + 5) + ' km/h']), exp: `Multiply by 18/5: ${m} × 18/5 = ${kmh} km/h.` }; },
  () => { const k = ri(2, 20) * 18; const ms = round2((k * 5) / 18); return { wa: `🔄 Convert ${k} km/h into m/s.`, o: opts(ms + ' m/s', [round2(k * 18 / 5) + ' m/s', round2(k / 10) + ' m/s', round2(ms + 2) + ' m/s']), exp: `Multiply by 5/18: ${k} × 5/18 = ${ms} m/s.` }; },
  () => { const s = ri(30, 70), t = ri(2, 5), N = pick(NAMES); return { wa: `🚶 ${N} walks ${fmt(s * t)} m in ${t} minutes. What is the speed in metres per minute?`, o: opts(s + ' m/min', [fmt(s * t) + ' m/min', round2(s / t) + ' m/min', (s + t) + ' m/min']), exp: `${fmt(s * t)} ÷ ${t} = ${s} metres per minute.` }; },
  () => { const s1 = ri(30, 60), s2 = ri(30, 60), t = ri(2, 5); if (s1 === s2) return null; return { wa: `🏁 Two trains leave together for ${t} hours — one at ${s1} km/h, the other at ${s2} km/h. How far apart are they, travelling in opposite directions?`, o: opts(fmt((s1 + s2) * t) + ' km', [fmt(Math.abs(s1 - s2) * t) + ' km', fmt((s1 + s2)) + ' km', fmt(s1 * t) + ' km']), exp: `Moving apart, the speeds add: (${s1} + ${s2}) × ${t} = ${fmt((s1 + s2) * t)} km.` }; },
  () => { const s = ri(40, 80), d = s * ri(2, 6); const half = round2(d / (2 * s)); return { wa: `🛞 A journey of ${fmt(d)} km is done at ${s} km/h. How long does HALF the journey take?`, o: opts(half + ' hours', [round2(half * 2) + ' hours', round2(half / 2) + ' hours', round2(half + 1) + ' hours']), exp: `Half the distance is ${fmt(d / 2)} km, and ${fmt(d / 2)} ÷ ${s} = ${half} hours.` }; },
  () => { const s = ri(40, 90); return { wa: `⚖️ If the distance stays the same and the speed doubles, what happens to the time taken?`, o: among('It is halved', ['It doubles', 'It stays the same', 'It becomes four times']), exp: `Speed and time are inversely proportional — go twice as fast and it takes half as long.` }; },
  () => { const s = ri(40, 80), t = ri(2, 6), late = ri(1, 3); return { wa: `🕰️ A train should cover ${fmt(s * t)} km in ${t} hours but takes ${t + late} hours. What was its actual speed?`, o: opts(round2((s * t) / (t + late)) + ' km/h', [s + ' km/h', round2(s / (t + late)) + ' km/h', round2((s * t) / t + late) + ' km/h']), exp: `${fmt(s * t)} ÷ ${t + late} = ${round2((s * t) / (t + late))} km/h.` }; },
];

module.exports = { integers, numberTheory, exponents, algebraBasics, simultaneous,
  quadratics, polynomials, factorisation, inequations, sets, percentage, ratio,
  numberSystems, speedDistanceTime };
