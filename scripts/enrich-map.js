/**
 * scripts/enrich-map.js
 * ---------------------------------------------------------------------------
 * Maps each thin chapter onto the topic families that suit it.
 *
 * The new NCERT titles are deliberately playful — "Coconut Farm", "Grandmother's
 * Quilt", "Utsav" — and say nothing about the maths inside. Every mapping below
 * was decided by reading the questions already sitting in that chapter, not by
 * guessing from the title.
 *
 * A chapter may draw on more than one family. "Zero" is counting AND addition;
 * "Number Play" is patterns AND sequences. Listing both keeps a quiz varied
 * without drifting off-syllabus.
 * ---------------------------------------------------------------------------
 */

const MAP = {
  /* ---- counting, place value, large numbers ------------------------------ */
  'Finding the Furry Cat!': ['placeValue'],
  'Number 10': ['placeValue', 'addSub'],
  'Zero': ['placeValue', 'addSub'],
  'Units and Tens': ['placeValue'],
  "What's in a Name?": ['placeValue'],
  'House of Hundreds - I': ['placeValue'],
  'House of Hundreds - II': ['placeValue'],
  'Double Century': ['placeValue'],
  'Thousands Around Us': ['placeValue'],
  'Numbers': ['placeValue'],
  'Numbers up to 10,000': ['placeValue'],
  '5-digit Numbers': ['placeValue'],
  'Large Numbers': ['placeValue'],
  'We the Travellers - I': ['placeValue'],
  'We the Travellers - II': ['placeValue'],
  'The Number Line': ['placeValue', 'integers'],
  'Mental Arithmetic': ['addSub', 'mulDiv', 'placeValue'],

  /* ---- the four operations ---------------------------------------------- */
  'A Day at the Beach': ['mulDiv', 'placeValue'],
  'Equal Groups': ['mulDiv'],
  'Coconut Farm': ['mulDiv'],

  /* ---- fractions and decimals ------------------------------------------- */
  'Fractions': ['fractions'],
  'Fractional Numbers': ['fractions'],
  'Fractions: Half and Quarter': ['fractions'],
  'Fractions in Disguise': ['fractions'],
  'Sharing and Measuring': ['fractions'],
  'Rational Numbers': ['fractions', 'numberSystems'],
  'Decimals': ['decimals'],
  'Decimal Fractions': ['decimals', 'fractions'],
  'Decimals - Multiplication and Division': ['decimals'],

  /* ---- money ------------------------------------------------------------- */
  'Money': ['money'],
  'Addition and Subtraction of Money': ['money', 'addSub'],

  /* ---- patterns and sequences ------------------------------------------- */
  'Patterns': ['patterns'],
  'Pattern Around Us': ['patterns'],
  'Patterns and Symmetry': ['patterns'],
  'Patterns in Mathematics': ['patterns', 'progressions'],
  'Utsav': ['patterns'],
  'Elephants, Tigers and Leopards': ['patterns', 'placeValue'],
  'Playing with Lines': ['patterns'],
  'Sequences': ['patterns', 'progressions'],
  'Number Play': ['patterns', 'progressions'],

  /* ---- data handling ----------------------------------------------------- */
  'Data Handling': ['dataHandling'],
  'Data Through Pictures': ['dataHandling'],
  'Collection and Tabulation of Data': ['dataHandling'],
  'Tabulation and Representation of Data': ['dataHandling'],
  'Bar Charts, Pie Charts and Histograms': ['dataHandling', 'statistics'],
  'Data Handling and Presentation': ['dataHandling', 'statistics'],
  'Statistics and Graph Work': ['statistics', 'dataHandling'],

  /* ---- integers and number theory --------------------------------------- */
  'Integers': ['integers'],
  'Integers - Multiplication and Division': ['integers'],
  'Factors and Multiples': ['numberTheory'],
  'Factors, Multiples, HCF and LCM': ['numberTheory'],
  'HCF and LCM': ['numberTheory'],
  'Prime Time': ['numberTheory'],

  /* ---- exponents --------------------------------------------------------- */
  'Exponents': ['exponents'],
  'Exponents: Review and Laws of Indices': ['exponents'],
  'Indices': ['exponents'],
  'Power Play': ['exponents'],
  'Powers and Roots': ['exponents'],
  'A Square and A Cube': ['exponents'],

  /* ---- algebra ----------------------------------------------------------- */
  'Algebra Play': ['algebraBasics'],
  'Algebra: Basic Concepts': ['algebraBasics'],
  'Algebra: Fundamental Concepts': ['algebraBasics'],
  'Fundamental Operations in Algebra': ['algebraBasics'],
  'Simplification of Algebraic Expressions': ['algebraBasics'],
  'Simplification and Removal of Brackets': ['algebraBasics', 'factorisation'],
  'Substitution': ['algebraBasics'],
  'Change of Subject and Substitution': ['algebraBasics'],
  'Formulae: Framing and Change of Subject': ['algebraBasics'],
  'Simple Linear Equations': ['algebraBasics'],
  'Linear Equations in Two Variables': ['algebraBasics', 'simultaneous'],
  'Equations and Inequations': ['algebraBasics', 'inequations'],
  'Simultaneous Linear Equations': ['simultaneous'],
  'Pair of Linear Equations in Two Variables': ['simultaneous'],
  'Graphical Solution of Simultaneous Equations': ['simultaneous', 'coordinates'],
  'Quadratic Equations': ['quadratics'],
  'Problems on Quadratic Equations': ['quadratics'],
  'Polynomials': ['polynomials'],
  'Linear Polynomials': ['polynomials'],
  'Factorisation': ['factorisation'],
  'Expansions': ['factorisation'],
  'Algebraic Identities': ['factorisation'],
  'Special Products and Identities': ['factorisation'],
  'We Distribute, Yet Things Multiply': ['factorisation', 'algebraBasics'],
  'Linear Inequations': ['inequations'],
  'Linear Inequations in One Variable': ['inequations'],

  /* ---- sets -------------------------------------------------------------- */
  'Sets': ['sets'],
  'Operations on Sets': ['sets'],
  'Venn Diagrams': ['sets'],
  'Representing Sets with Venn Diagrams': ['sets'],
  'Cardinal Property of a Set': ['sets'],

  /* ---- commercial arithmetic --------------------------------------------- */
  'Percentage': ['percentage'],
  'Percent and Percentage': ['percentage'],
  'Profit and Loss': ['percentage'],
  'Profit, Loss and Discount': ['percentage'],
  'Simple Interest': ['percentage'],
  'Compound Interest': ['percentage'],
  'Compound Interest Using Formula': ['percentage'],
  'Compound Interest Without Formula': ['percentage'],
  'Goods and Services Tax (GST)': ['percentage'],
  'Banking: Maturity Value and Interest': ['percentage'],
  'Banking: Recurring Deposit Accounts': ['percentage'],
  'Shares and Dividends': ['percentage'],
  'Proportional Reasoning - 2': ['percentage', 'ratio'],
  'Ratio and Proportion': ['ratio'],
  'Ratio, Proportion and Unitary Method': ['ratio'],
  'Unitary Method': ['ratio'],
  'Unitary Method (Time and Work)': ['ratio'],
  'Direct and Inverse Variation': ['ratio'],
  'Proportional Reasoning - 1': ['ratio'],
  // NOT ['ratio'] — generic ratio shapes here put "simplify 6 : 28" inside a
  // chapter named Speed, Distance and Time, which misreports what a child
  // practised in the chapter breakdown of their report.
  'Speed, Distance and Time': ['speedDistanceTime'],

  /* ---- number systems ---------------------------------------------------- */
  'Number Systems': ['numberSystems'],
  'Real Numbers': ['numberSystems'],
  'Rational and Irrational Numbers': ['numberSystems'],
  'A Story of Numbers': ['numberSystems'],

  /* ---- geometry ---------------------------------------------------------- */
  'Lines and Angles': ['linesAngles'],
  'Angles and Their Measurement': ['linesAngles'],
  'Properties of Angles and Lines': ['linesAngles'],
  'Geometry: Fundamental Concepts': ['linesAngles'],
  'Exploring Some Geometric Themes': ['linesAngles'],
  'Triangles': ['triangles'],
  'Congruent Triangles': ['triangles'],
  'Congruency in Triangles': ['triangles'],
  'Congruence of Plane Figures': ['triangles', 'quadrilaterals'],
  'Isosceles Triangles': ['triangles'],
  'Inequalities in Triangles': ['triangles'],
  'Pythagoras Theorem': ['triangles'],
  'The Baudhayana-Pythagoras Theorem': ['triangles'],
  'Introduction to Theorems: Pythagoras': ['triangles'],
  "Heron's Formula": ['triangles', 'perimeterArea'],
  'Theorems on Area': ['triangles', 'perimeterArea'],
  'Area Propositions': ['triangles', 'perimeterArea'],
  'Quadrilaterals': ['quadrilaterals'],
  'Circles': ['circles'],
  'The Circle': ['circles'],
  'Describing a Circle': ['circles'],
  'Circumference and Area of a Circle': ['circles'],
  'Areas Related to Circles': ['circles'],

  /* ---- mensuration -------------------------------------------------------- */
  'Perimeter and Area': ['perimeterArea'],
  'Area': ['perimeterArea'],
  'Area and Perimeter of Plane Figures': ['perimeterArea', 'quadrilaterals'],
  'Perimeter and Area of Simple Figures': ['perimeterArea'],
  'Mensuration: Perimeter and Area': ['perimeterArea'],
  "Grandmother's Quilt": ['perimeterArea'],
  'Surface Areas and Volumes': ['solids'],
  'Perimeter, Area and Volume': ['perimeterArea', 'solids'],

  /* ---- coordinate geometry ------------------------------------------------ */
  'Coordinate Geometry': ['coordinates'],
  'Co-ordinate Geometry': ['coordinates'],
  'Plotting of Points and Co-ordinates': ['coordinates'],
  'Graphs and Co-ordinates': ['coordinates'],
  'Graphs': ['coordinates'],
  'Distance Formula': ['coordinates'],
  'Distance and Section Formulae': ['coordinates'],
  'Equation of a Straight Line': ['coordinates'],
  'Reflection': ['coordinates'],
  'Tales by Dots and Lines': ['coordinates'],
  'Relations and Mapping': ['relations'],
  'Relations and Mappings': ['relations'],

  /* ---- trigonometry, stats, probability ----------------------------------- */
  'Some Applications of Trigonometry': ['trigonometry'],
  'Heights and Distances': ['trigonometry'],
  'Statistics': ['statistics'],
  'Arithmetic Mean, Median and Mode': ['statistics'],
  'Data Handling - Mean, Median and Mode': ['statistics'],
  'Mean and Median of Ungrouped Data': ['statistics'],
  'Measures of Central Tendency': ['statistics'],
  'Probability': ['probability'],

  /* ---- measurement --------------------------------------------------------- */
  'Measurement - Length': ['measurement'],
  'Measurement - Weight': ['measurement'],
  'Measuring Length': ['measurement'],
  'Length': ['measurement'],
  'Far and Near': ['measurement'],
  'Fun at Class Party!': ['measurement'],

  /* ---- progressions and matrices ------------------------------------------- */
  'Arithmetic Progression': ['progressions'],
  'Arithmetic Progressions': ['progressions'],
  'Geometric Progression': ['progressions'],
  'Matrices': ['matrices'],
};

module.exports = MAP;
