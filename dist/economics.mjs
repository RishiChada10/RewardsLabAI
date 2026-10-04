export const categories = [
  "dining",
  "travel",
  "groceries",
  "gas",
  "entertainment",
  "general",
];

export const personas = {
  professional: {
    id: "professional",
    name: "Young professional",
    description: "Dining-led, digitally active, growing travel spend",
    spending: {
      dining: 7200,
      travel: 4800,
      groceries: 5400,
      gas: 1800,
      entertainment: 3000,
      general: 9000,
    },
    benefitUtilization: 0.7,
    valueThreshold: 100,
  },
  family: {
    id: "family",
    name: "Affluent family",
    description: "High grocery, household, and everyday spend",
    spending: {
      dining: 4800,
      travel: 3600,
      groceries: 14400,
      gas: 3600,
      entertainment: 2400,
      general: 12000,
    },
    benefitUtilization: 0.55,
    valueThreshold: 125,
  },
  traveler: {
    id: "traveler",
    name: "Frequent traveler",
    description: "High travel, dining, and total card spend",
    spending: {
      dining: 9000,
      travel: 18000,
      groceries: 4800,
      gas: 1500,
      entertainment: 3600,
      general: 15000,
    },
    benefitUtilization: 0.9,
    valueThreshold: 175,
  },
};

export const defaultCard = {
  name: "Mass Affluent Explorer",
  annualFee: 125,
  baseRate: 1,
  bonusRates: {
    dining: 3,
    travel: 3,
    groceries: 2,
    gas: 1,
    entertainment: 1,
    general: 1,
  },
  welcomePoints: 50000,
  interchangeRate: 0.018,
  breakageRate: 0.15,
  issuerCostPerPoint: 0.009,
  customerValuePerPoint: 0.0125,
  annualBenefitValue: 240,
  annualBenefitCost: 140,
};

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function normalizeCard(input = {}) {
  const bonusRates = {};
  for (const category of categories) {
    bonusRates[category] = clamp(
      input.bonusRates?.[category] ?? defaultCard.bonusRates[category],
      0.5,
      10,
    );
  }

  return {
    name: String(input.name || defaultCard.name).slice(0, 70),
    annualFee: clamp(input.annualFee ?? defaultCard.annualFee, 0, 1000),
    baseRate: clamp(input.baseRate ?? defaultCard.baseRate, 0.5, 5),
    bonusRates,
    welcomePoints: clamp(input.welcomePoints ?? defaultCard.welcomePoints, 0, 250000),
    interchangeRate: clamp(input.interchangeRate ?? defaultCard.interchangeRate, 0, 0.05),
    breakageRate: clamp(input.breakageRate ?? defaultCard.breakageRate, 0, 0.75),
    issuerCostPerPoint: clamp(input.issuerCostPerPoint ?? defaultCard.issuerCostPerPoint, 0.001, 0.03),
    customerValuePerPoint: clamp(
      input.customerValuePerPoint ?? defaultCard.customerValuePerPoint,
      0.005,
      0.03,
    ),
    annualBenefitValue: clamp(input.annualBenefitValue ?? defaultCard.annualBenefitValue, 0, 2000),
    annualBenefitCost: clamp(input.annualBenefitCost ?? defaultCard.annualBenefitCost, 0, 2000),
  };
}

export function simulate(cardInput, personaInput) {
  const card = normalizeCard(cardInput);
  const persona = personaInput;
  if (!persona?.spending) throw new Error("A valid persona is required");

  let annualSpend = 0;
  let pointsEarned = 0;
  const categoryResults = {};

  for (const category of categories) {
    const spend = Number(persona.spending[category] || 0);
    const rate = Number(card.bonusRates[category] || card.baseRate);
    const points = spend * rate;
    annualSpend += spend;
    pointsEarned += points;
    categoryResults[category] = { spend, rate, points };
  }

  const customerPointsValue = pointsEarned * card.customerValuePerPoint;
  const usableBenefitValue = card.annualBenefitValue * persona.benefitUtilization;
  const ongoingCustomerValue = customerPointsValue + usableBenefitValue - card.annualFee;
  const welcomeCustomerValue = card.welcomePoints * card.customerValuePerPoint;
  const yearOneCustomerValue = ongoingCustomerValue + welcomeCustomerValue;

  const interchangeRevenue = annualSpend * card.interchangeRate;
  const redeemedPoints = pointsEarned * (1 - card.breakageRate);
  const ongoingRewardsCost = redeemedPoints * card.issuerCostPerPoint;
  const welcomeOfferCost = card.welcomePoints * (1 - card.breakageRate) * card.issuerCostPerPoint;
  const ongoingContribution =
    interchangeRevenue + card.annualFee - ongoingRewardsCost - card.annualBenefitCost;
  const yearOneContribution = ongoingContribution - welcomeOfferCost;
  const rewardsAndBenefitsCost = ongoingRewardsCost + card.annualBenefitCost;
  const costToSpendRatio = annualSpend ? rewardsAndBenefitsCost / annualSpend : 0;

  return {
    personaId: persona.id,
    annualSpend,
    pointsEarned,
    customerPointsValue,
    usableBenefitValue,
    ongoingCustomerValue,
    welcomeCustomerValue,
    yearOneCustomerValue,
    interchangeRevenue,
    redeemedPoints,
    ongoingRewardsCost,
    welcomeOfferCost,
    ongoingContribution,
    yearOneContribution,
    rewardsAndBenefitsCost,
    costToSpendRatio,
    clearsPersonaThreshold: ongoingCustomerValue >= persona.valueThreshold,
    categoryResults,
  };
}

export function simulatePortfolio(card, personaMap = personas) {
  return Object.values(personaMap).map((persona) => simulate(card, persona));
}

export function parseBriefOffline(brief, current = defaultCard) {
  const text = String(brief || "").toLowerCase();
  const next = normalizeCard(structuredClone(current));
  const changes = [];

  if (/\b(no|zero|\$0)\s+annual fee\b/.test(text)) {
    next.annualFee = 0;
    changes.push("Set annual fee to $0");
  } else {
    const ceilingMatch = text.match(/\bfee\b[^.$\d]{0,30}\b(?:under|below|less than)\s*\$?([0-9]{2,3})/)
      || text.match(/\b(?:under|below|less than)\s*\$?([0-9]{2,3})\s*(?:annual\s*)?fee\b/);
    const exactMatch = text.match(/\$([0-9]{2,3})\s*(?:annual\s*)?fee\b/)
      || text.match(/\bfee\s*(?:of|at|is|=)?\s*\$([0-9]{2,3})/);
    if (ceilingMatch) {
      next.annualFee = Math.max(0, Number(ceilingMatch[1]) - 25);
      changes.push(`Set annual fee to $${next.annualFee}`);
    } else if (exactMatch) {
      next.annualFee = Number(exactMatch[1]);
      changes.push(`Set annual fee to $${next.annualFee}`);
    }
  }

  const categoryPatterns = {
    dining: /\b(dining|restaurants?|food delivery)\b/,
    travel: /\b(travel|flights?|hotels?|airfare)\b/,
    groceries: /\b(grocery|groceries|supermarkets?)\b/,
    gas: /\b(gas|gasoline|fuel|ev charging)\b/,
    entertainment: /\b(entertainment|streaming|concerts?)\b/,
    general: /\b(general|everyday|all other)\b/,
  };
  const mentioned = categories
    .map((category) => ({ category, index: text.search(categoryPatterns[category]) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.category);

  mentioned.forEach((category, index) => {
    next.bonusRates[category] = index < 2 ? 3 : 2;
  });
  if (mentioned.length) changes.push(`Prioritized ${mentioned.join(" and ")}`);

  if (/premium|luxury/.test(text)) {
    next.annualFee = Math.max(next.annualFee, 250);
    next.annualBenefitValue = 450;
    next.annualBenefitCost = 260;
    changes.push("Added a premium benefit package");
  }

  const welcomeMatch = text.match(/\b([0-9]{2,3})(?:,?000|k)\s+(?:bonus\s+|welcome\s+)?points?\b/);
  if (welcomeMatch) {
    next.welcomePoints = Number(welcomeMatch[1]) * 1000;
    changes.push(`Set welcome offer to ${next.welcomePoints.toLocaleString()} points`);
  }

  if (!changes.length) {
    changes.push("No recognizable terms found in the brief; kept the current configuration");
  }
  return { card: normalizeCard(next), changes, mode: "offline-demo" };
}

export function constraintStatus(result, objective) {
  const customerGap = Math.max(0, objective.minimumCustomerValue - result.ongoingCustomerValue);
  const costGap = Math.max(0, result.costToSpendRatio - objective.maximumCostRatio);
  const contributionGap = Math.max(0, objective.minimumContribution - result.ongoingContribution);
  return {
    met: customerGap === 0 && costGap === 0 && contributionGap === 0,
    customerGap,
    costGap,
    contributionGap,
  };
}

export function optimizeCard(cardInput, persona, objectiveInput = {}, maxAttempts = 5) {
  const objective = {
    minimumCustomerValue: Number(objectiveInput.minimumCustomerValue ?? 100),
    maximumCostRatio: Number(objectiveInput.maximumCostRatio ?? 0.022),
    minimumContribution: Number(objectiveInput.minimumContribution ?? 0),
  };
  let card = normalizeCard(structuredClone(cardInput));
  const topCategory = categories.reduce((best, category) =>
    persona.spending[category] > persona.spending[best] ? category : best,
  categories[0]);
  const attempts = [];

  for (let index = 0; index < maxAttempts; index += 1) {
    const result = simulate(card, persona);
    const status = constraintStatus(result, objective);
    let explanation = "Current design tested against all objectives.";

    if (index > 0) {
      explanation = card.__reason || "Adjusted the card and reran the simulator.";
    }

    attempts.push({
      number: index + 1,
      card: normalizeCard(card),
      result,
      status,
      explanation,
    });
    if (status.met) break;

    const next = normalizeCard(structuredClone(card));
    if (status.customerGap > 0 && result.costToSpendRatio < objective.maximumCostRatio * 0.96) {
      next.bonusRates[topCategory] = clamp(next.bonusRates[topCategory] + 0.5, 0.5, 10);
      next.__reason = `Raised ${topCategory} rewards because it is this persona's largest spending category.`;
    } else if (status.customerGap > 0 && next.annualFee >= 25) {
      next.annualFee -= 25;
      next.__reason = "Reduced the annual fee to improve ongoing customer value.";
    } else if (status.costGap > 0 && next.bonusRates[topCategory] > 1) {
      next.bonusRates[topCategory] = clamp(next.bonusRates[topCategory] - 0.5, 0.5, 10);
      next.__reason = `Reduced ${topCategory} rewards to bring issuer cost within the limit.`;
    } else if (status.contributionGap > 0) {
      next.annualFee = clamp(next.annualFee + 25, 0, 1000);
      next.__reason = "Raised the annual fee to improve ongoing issuer contribution.";
    } else {
      next.annualBenefitCost = clamp(next.annualBenefitCost - 10, 0, 2000);
      next.__reason = "Reduced modeled benefit cost while preserving customer-facing value.";
    }
    card = next;
  }

  return {
    objective,
    personaId: persona.id,
    topCategory,
    attempts,
    recommended: attempts.at(-1),
  };
}

export function checkClaim(claimInput, cardInput, portfolioResults) {
  const claim = String(claimInput || "").trim();
  const text = claim.toLowerCase();
  const card = normalizeCard(cardInput);
  const findings = [];

  if (/all travel/.test(text) && card.bonusRates.travel <= card.baseRate) {
    findings.push({
      severity: "high",
      title: "Travel claim does not match the earn rules",
      detail: `Travel earns ${card.bonusRates.travel}x, the same as or below the base rate.`,
    });
  }

  const valueMatch = text.match(/\$([0-9,]+)/);
  if (valueMatch) {
    const claimed = Number(valueMatch[1].replaceAll(",", ""));
    const maxOngoing = Math.max(...portfolioResults.map((result) => result.ongoingCustomerValue));
    const maxYearOne = Math.max(...portfolioResults.map((result) => result.yearOneCustomerValue));
    if (claimed > maxOngoing && claimed <= maxYearOne) {
      findings.push({
        severity: "medium",
        title: "Claim appears to rely on the welcome offer",
        detail: `Maximum simulated ongoing value is ${money(maxOngoing)}, while year-one value reaches ${money(maxYearOne)}.`,
      });
    } else if (claimed > maxYearOne) {
      findings.push({
        severity: "high",
        title: "Claim exceeds simulated value",
        detail: `The highest simulated year-one value is ${money(maxYearOne)}.`,
      });
    }
  }

  if (!/fee/.test(text) && card.annualFee > 0 && /value|worth|save|earn/.test(text)) {
    findings.push({
      severity: "low",
      title: "Annual fee is not acknowledged",
      detail: `The card has a ${money(card.annualFee)} annual fee. Net-value statements should clarify whether it was deducted.`,
    });
  }

  return findings.length
    ? findings
    : [{ severity: "pass", title: "No obvious mismatch found", detail: "The claim still requires human legal and compliance review." }];
}

export function money(value, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(Number(value || 0));
}

export function number(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
}
