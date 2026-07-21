// roles.js — map an agent's role to a human labor-hour cost.
//
// Salary source: a built-in table of approximate US average BASE salaries.
// Glassdoor has no open public API, so this table is the offline default; it
// can be edited here, overridden per-role, or later populated from a salary
// API (e.g. BLS OEWS or Adzuna). Hourly rate = annual / WORK_HOURS_PER_YEAR.

const WORK_HOURS_PER_YEAR = 2080; // 40h/week * 52 weeks

// role -> approximate US average annual base salary (USD)
const SALARIES = {
  'Software Engineer': 120000,
  'Frontend Engineer': 115000,
  'Backend Engineer': 125000,
  'Full Stack Engineer': 120000,
  'Data Engineer': 130000,
  'Data Analyst': 85000,
  'DevOps Engineer': 135000,
  'QA Engineer': 95000,
  'Solutions Architect': 155000,
  'Technical Writer': 80000,
};

const DEFAULT_ROLE = 'Software Engineer';

function hourlyRate(role) {
  const salary = SALARIES[role] != null ? SALARIES[role] : SALARIES[DEFAULT_ROLE];
  return Math.round((salary / WORK_HOURS_PER_YEAR) * 100) / 100;
}

// Best-effort role guess from the project name / cwd keywords.
function inferRole({ title, cwd } = {}) {
  const s = `${title || ''} ${cwd || ''}`.toLowerCase();
  if (/snowflake|warehouse|\bdbt\b|fivetran|etl|pipeline|coalesce/.test(s)) return 'Data Engineer';
  if (/report|analytics|dashboard|\bbi\b|metric/.test(s)) return 'Data Analyst';
  if (/website|frontend|front-end|react|angular|\bui\b|customerportal|webapp/.test(s)) return 'Frontend Engineer';
  if (/backend|\bapi\b|_be\b|service|server|cms/.test(s)) return 'Backend Engineer';
  if (/azure|devops|infra|terraform|pipeline|deploy|k8s|docker/.test(s)) return 'DevOps Engineer';
  if (/architect|ecosphere|\bea\b|layr/.test(s)) return 'Solutions Architect';
  return DEFAULT_ROLE;
}

// Labor summary for a session given active work time (ms) and its role.
function laborSummary(activeMs, role) {
  const hours = Math.round(((activeMs || 0) / 3_600_000) * 1000) / 1000;
  const rate = hourlyRate(role);
  const cost = Math.round(hours * rate * 100) / 100;
  return { role, hourlyRate: rate, annualSalary: SALARIES[role] || SALARIES[DEFAULT_ROLE], hours, cost };
}

module.exports = {
  SALARIES, DEFAULT_ROLE, WORK_HOURS_PER_YEAR,
  hourlyRate, inferRole, laborSummary, ROLE_LIST: Object.keys(SALARIES),
};
