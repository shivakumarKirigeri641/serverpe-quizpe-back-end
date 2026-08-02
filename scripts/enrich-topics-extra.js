/**
 * scripts/enrich-topics-extra.js
 * ---------------------------------------------------------------------------
 * Topics that did not fit the three main groups: progressions, matrices and
 * relations/mappings. Small libraries, same contract as the others.
 * ---------------------------------------------------------------------------
 */

const H = require('./enrich-questions.js');
const { ri, pick, opts, yesNo, among, near, fmt, round2, NAMES } = H;

const sgn = (n) => (n < 0 ? `− ${Math.abs(n)}` : `+ ${n}`);

/* =========================================================== progressions === */
const progressions = [
  () => { const a = ri(2, 20), d = ri(2, 9); return { wa: `📈 What is the common difference of the AP ${a}, ${a + d}, ${a + 2 * d}, ${a + 3 * d}, ...?`, o: opts(d, near(d)), exp: `Subtract any term from the next: ${a + d} − ${a} = ${d}.` }; },
  () => { const a = ri(2, 20), d = ri(2, 9), n = ri(5, 20); const t = a + (n - 1) * d; return { wa: `🎯 Find the ${n}th term of the AP ${a}, ${a + d}, ${a + 2 * d}, ...`, o: opts(t, near(t)), exp: `aₙ = a + (n−1)d = ${a} + ${n - 1}×${d} = ${t}.` }; },
  () => { const a = ri(2, 15), d = ri(2, 8), n = ri(5, 15); const s = (n * (2 * a + (n - 1) * d)) / 2; return { wa: `➕ Find the sum of the first ${n} terms of the AP ${a}, ${a + d}, ${a + 2 * d}, ...`, o: opts(s, near(s)), exp: `Sₙ = n/2 × [2a + (n−1)d] = ${n}/2 × [${2 * a} + ${(n - 1) * d}] = ${fmt(s)}.` }; },
  () => { const a = ri(20, 60), d = -ri(2, 8), n = ri(4, 8); const t = a + (n - 1) * d; return { wa: `📉 Find the ${n}th term of the AP ${a}, ${a + d}, ${a + 2 * d}, ...`, o: opts(t, near(t)), exp: `The common difference is ${d}. aₙ = ${a} + ${n - 1}×(${d}) = ${t}.` }; },
  () => { const a = ri(2, 15), d = ri(2, 8); return { wa: `🔍 Is the sequence ${a}, ${a + d}, ${a + 2 * d}, ${a + 3 * d + 1} an AP?`, o: yesNo(false, 'Yes', 'No'), exp: `The gaps are ${d}, ${d} and ${d + 1} — not all equal, so it is not an AP.` }; },
  () => { const a = ri(2, 15), d = ri(2, 8); return { wa: `🔍 Is the sequence ${a}, ${a + d}, ${a + 2 * d}, ${a + 3 * d} an AP?`, o: yesNo(true, 'Yes', 'No'), exp: `Each gap is ${d}, so yes — it is an AP with common difference ${d}.` }; },
  () => { const n = ri(10, 60); const s = (n * (n + 1)) / 2; return { wa: `➕ Find the sum of the first ${n} natural numbers.`, o: opts(s, near(s)), exp: `Sum = n(n+1)/2 = ${n}×${n + 1}/2 = ${fmt(s)}.` }; },
  () => { const a = ri(2, 10), r = ri(2, 3), n = ri(3, 6); const t = a * r ** (n - 1); return { wa: `📈 Find the ${n}th term of the GP ${a}, ${a * r}, ${a * r * r}, ...`, o: opts(t, [a * r ** n, a * r * n, t + r]), exp: `aₙ = a·r^(n−1) = ${a} × ${r}^${n - 1} = ${fmt(t)}.` }; },
  () => { const a = ri(2, 10), r = ri(2, 4); return { wa: `📈 What is the common ratio of the GP ${a}, ${a * r}, ${a * r * r}, ...?`, o: opts(r, near(r)), exp: `Divide any term by the one before: ${a * r} ÷ ${a} = ${r}.` }; },
  () => { const a = ri(2, 12), d = ri(2, 6), n = ri(6, 15); const t = a + (n - 1) * d; return { wa: `🪑 Row 1 of a hall has ${a} seats, and each next row has ${d} more. How many seats in row ${n}?`, o: opts(t, near(t)), exp: `This is an AP: ${a} + ${n - 1}×${d} = ${t} seats.` }; },
  () => { const a = ri(2, 15), d = ri(2, 8), n = ri(4, 12); const t = a + (n - 1) * d; return { wa: `🧩 In an AP the first term is ${a} and the ${n}th term is ${t}. What is the common difference?`, o: opts(d, near(d)), exp: `${t} = ${a} + ${n - 1}d, so ${n - 1}d = ${t - a} and d = ${d}.` }; },
];

/* =============================================================== matrices === */
const matrices = [
  () => { const A = [[ri(-9, 9), ri(-9, 9)], [ri(-9, 9), ri(-9, 9)]]; const k = ri(2, 5); const R = A.map((r) => r.map((x) => x * k)); return { wa: `✖️ If A = [[${A[0]}], [${A[1]}]], find ${k}A.`, o: among(`[[${R[0]}], [${R[1]}]]`, [`[[${A[0]}], [${A[1]}]]`, `[[${A.map((r) => r.map((x) => x + k))[0]}], [${A.map((r) => r.map((x) => x + k))[1]}]]`, `[[${R[1]}], [${R[0]}]]`]), exp: `Scalar multiplication multiplies every entry by ${k}.` }; },
  () => { const A = [[ri(-9, 9), ri(-9, 9)], [ri(-9, 9), ri(-9, 9)]]; const B = [[ri(-9, 9), ri(-9, 9)], [ri(-9, 9), ri(-9, 9)]]; const R = A.map((r, i) => r.map((x, j) => x + B[i][j])); return { wa: `➕ If A = [[${A[0]}], [${A[1]}]] and B = [[${B[0]}], [${B[1]}]], find A + B.`, o: among(`[[${R[0]}], [${R[1]}]]`, [`[[${A.map((r, i) => r.map((x, j) => x - B[i][j]))[0]}], [${A.map((r, i) => r.map((x, j) => x - B[i][j]))[1]}]]`, `[[${A[0]}], [${A[1]}]]`, `[[${B[0]}], [${B[1]}]]`]), exp: `Matrices add entry by entry, position matching position.` }; },
  () => { const A = [[ri(-9, 9), ri(-9, 9)], [ri(-9, 9), ri(-9, 9)]]; const d = A[0][0] * A[1][1] - A[0][1] * A[1][0]; return { wa: `🔢 Find the determinant of [[${A[0]}], [${A[1]}]].`, o: opts(d, near(d)), exp: `Determinant = (${A[0][0]}×${A[1][1]}) − (${A[0][1]}×${A[1][0]}) = ${A[0][0] * A[1][1]} − ${A[0][1] * A[1][0]} = ${d}.` }; },
  () => { const r = ri(2, 4), c = ri(2, 4); return { wa: `📐 A matrix has ${r} rows and ${c} columns. What is its order?`, o: among(`${r} × ${c}`, [`${c} × ${r}`, `${r * c} × 1`, `${r + c}`]), exp: `Order is written rows × columns, so ${r} × ${c}.` }; },
  () => { const r = ri(2, 4), c = ri(2, 4); return { wa: `🔢 How many elements does a ${r} × ${c} matrix have?`, o: opts(r * c, [r + c, r, c]), exp: `${r} rows × ${c} columns = ${r * c} elements.` }; },
  () => { const A = [[ri(-9, 9), ri(-9, 9)], [ri(-9, 9), ri(-9, 9)]]; const T = [[A[0][0], A[1][0]], [A[0][1], A[1][1]]]; return { wa: `🔄 Find the transpose of [[${A[0]}], [${A[1]}]].`, o: among(`[[${T[0]}], [${T[1]}]]`, [`[[${A[0]}], [${A[1]}]]`, `[[${A[1]}], [${A[0]}]]`, `[[${T[1]}], [${T[0]}]]`]), exp: `The transpose swaps rows and columns.` }; },
  () => { const a = ri(2, 4), b = ri(2, 4), c = ri(2, 4); return { wa: `✖️ Can a ${a} × ${b} matrix be multiplied by a ${b} × ${c} matrix?`, o: yesNo(true, 'Yes', 'No'), exp: `Multiplication works when the columns of the first (${b}) match the rows of the second (${b}) — so yes, giving a ${a} × ${c} matrix.` }; },
];

/* ==================================================== relations and mappings === */
const relations = [
  () => { const a = ri(2, 9), b = ri(-9, 9), x = ri(1, 9); return { wa: `🔤 A mapping is f(x) = ${a}x ${sgn(b)}. Find f(${x}).`, o: opts(a * x + b, near(a * x + b)), exp: `f(${x}) = ${a}×${x} ${sgn(b)} = ${a * x} ${sgn(b)} = ${a * x + b}.` }; },
  () => { const a = ri(2, 9), b = ri(-9, 9), y = ri(2, 9); const x = a * y + b; return { wa: `🔍 For f(x) = ${a}x ${sgn(b)}, which value of x gives f(x) = ${x}?`, o: opts(y, near(y)), exp: `${a}x ${sgn(b)} = ${x}, so ${a}x = ${a * y} and x = ${y}.` }; },
  () => { const a = ri(2, 6), x = ri(1, 6); return { wa: `🔤 A mapping is f(x) = x² + ${a}. Find f(${x}).`, o: opts(x * x + a, near(x * x + a)), exp: `f(${x}) = ${x}² + ${a} = ${x * x} + ${a} = ${x * x + a}.` }; },
  () => { const pairs = Array.from({ length: 3 }, () => [ri(1, 9), ri(1, 9)]); const dom = pairs.map((p) => p[0]); if (new Set(dom).size !== 3) return null; return { wa: `📋 For the relation {${pairs.map((p) => `(${p[0]},${p[1]})`).join(', ')}}, what is the DOMAIN?`, o: among(`{${dom.sort((a, b) => a - b)}}`, [`{${pairs.map((p) => p[1]).sort((a, b) => a - b)}}`, `{${pairs.flat()}}`, '{ }']), exp: `The domain is the set of first elements: {${dom.sort((a, b) => a - b)}}.` }; },
  () => { const pairs = Array.from({ length: 3 }, () => [ri(1, 9), ri(1, 9)]); const ran = [...new Set(pairs.map((p) => p[1]))].sort((a, b) => a - b); if (new Set(pairs.map((p) => p[0])).size !== 3) return null; return { wa: `📋 For the relation {${pairs.map((p) => `(${p[0]},${p[1]})`).join(', ')}}, what is the RANGE?`, o: among(`{${ran}}`, [`{${pairs.map((p) => p[0]).sort((a, b) => a - b)}}`, `{${pairs.flat()}}`, '{ }']), exp: `The range is the set of second elements: {${ran}}.` }; },
  () => { const n = ri(2, 4), m = ri(2, 4); return { wa: `🔢 Set A has ${n} elements and set B has ${m}. How many ordered pairs are in A × B?`, o: opts(n * m, [n + m, n ** m, m ** n]), exp: `Each of the ${n} elements pairs with each of the ${m}: ${n} × ${m} = ${n * m} pairs.` }; },
  () => { const a = ri(2, 6), b = ri(1, 9); return { wa: `🔄 If f(x) = ${a}x, what is f(0)?`, o: opts(0, [a, b, 1]), exp: `f(0) = ${a} × 0 = 0.` }; },
  () => { const ok = pick([true, false]); return { wa: `🔍 Is the relation {(1,4), (2,5), (${ok ? 3 : 1},6)} a function?`, o: yesNo(ok, 'Yes', 'No'), exp: ok ? `Each first element (1, 2, 3) appears exactly once, so it is a function.` : `The element 1 is paired with both 4 and 6, so it is not a function.` }; },
];

module.exports = { progressions, matrices, relations };
