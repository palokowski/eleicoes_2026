const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const RECOUNT_DIR = path.join(ROOT, 'data', '2026', '1-turno');
const stateNames = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais',
  MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco',
  PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia',
  RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo',
  TO: 'Tocantins', ZZ: 'Exterior', BR: 'Brasil'
};

function readCsv(filename) {
  return parse(fs.readFileSync(filename, 'utf8'), { bom: true, columns: true, delimiter: ';', skip_empty_lines: true });
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function locationOf(row) {
  return row.nivel === 'br' ? 'BR' : row.uf;
}

// Votos por localidade e numero: Map('SP' => Map('22' => { votes, candidate, party })).
function votesByLocation(rows) {
  const result = new Map();
  for (const row of rows) {
    if (row.nivel !== 'br' && row.nivel !== 'uf') continue;
    const location = locationOf(row);
    if (!result.has(location)) result.set(location, new Map());
    result.get(location).set(String(Number(row.numero)), { votes: Number(row.votos), candidate: row.candidato, party: row.partido });
  }
  return result;
}

// A recontagem so e exibida se foi conferida (verificar.js) sobre os arquivos atuais.
function readRecount() {
  const report = readJson(path.join(RECOUNT_DIR, 'reconciliacao_presidente_bu.json'));
  const verification = readJson(path.join(RECOUNT_DIR, 'verificacao.json'));
  if (!report || !verification || verification.recountGeneratedAt !== report.generatedAt) return { report: null, verification: null, votes: new Map() };
  return { report, verification, votes: votesByLocation(readCsv(path.join(RECOUNT_DIR, 'votos_presidente_bu.csv'))) };
}

function buildResults() {
  const { report, verification, votes: recountVotes } = readRecount();
  const officialVotes = votesByLocation(readCsv(path.join(ROOT, 'votos_presidente.csv')));
  const summaries = new Map(readCsv(path.join(ROOT, 'apuracao_presidente.csv'))
    .filter((row) => row.nivel === 'br' || row.nivel === 'uf')
    .map((row) => [locationOf(row), row]));
  const statusByLocation = new Map((verification?.locations || []).map((item) => [item.location, item.status]));

  // BUs que o TSE lista mas que nao puderam ser lidos (ainda nao publicados, etc.).
  const missingBus = (report?.failures || []).map((failure) => ({
    uf: failure.section.uf,
    municipality: failure.section.municipalityName,
    zone: failure.section.zone,
    section: failure.section.section,
    reason: failure.missing || failure.error
  }));

  function buildLocation(location) {
    const official = officialVotes.get(location) || new Map();
    const status = statusByLocation.get(location) || 'pendente';
    const recount = status === 'pendente' ? null : recountVotes.get(location) || new Map();
    const summary = summaries.get(location) || {};
    const officialValid = [...official.values()].reduce((sum, item) => sum + item.votes, 0);
    const recountValid = recount ? [...recount.values()].reduce((sum, item) => sum + item.votes, 0) : null;
    const candidates = [...new Set([...official.keys(), ...(recount?.keys() || [])])]
      .map((number) => {
        const info = official.get(number) || recount.get(number);
        const officialCount = official.get(number)?.votes || 0;
        const recountCount = recount ? recount.get(number)?.votes || 0 : null;
        return {
          number,
          candidate: info.candidate,
          party: info.party,
          official: officialCount,
          recount: recountCount,
          difference: recount ? recountCount - officialCount : null,
          percentage: officialValid ? (officialCount / officialValid) * 100 : 0
        };
      })
      .sort((left, right) => right.official - left.official);

    return {
      id: location.toLowerCase(),
      uf: location,
      name: stateNames[location] || location,
      status,
      officialValid,
      recountValid,
      difference: recount ? recountValid - officialValid : null,
      electorate: Number(summary.eleitorado || 0),
      turnout: Number(summary.comparecimento || 0),
      abstention: Number(summary.abstencao || 0),
      blankVotes: Number(summary.brancos || 0),
      nullVotes: Number(summary.nulos || 0),
      missingBus: location === 'BR' ? missingBus : missingBus.filter((item) => item.uf === location),
      winner: candidates[0] || null,
      candidates
    };
  }

  const locations = [...officialVotes.keys()].filter((location) => location !== 'BR')
    .sort((left, right) => left === 'ZZ' ? 1 : right === 'ZZ' ? -1 : left.localeCompare(right))
    .map(buildLocation);

  return {
    verified: Boolean(verification?.verified),
    officialUpdatedAt: summaries.get('BR')?.atualizado_em || null,
    recountGeneratedAt: report?.generatedAt || null,
    recount: report ? {
      busRead: report.decodedSections,
      busExpected: report.expectedBuFiles,
      matchingLocations: locations.filter((item) => item.status === 'igual').length,
      totalLocations: locations.length
    } : null,
    verification: verification && {
      verified: verification.verified,
      checkedAt: verification.checkedAt,
      officialUpdatedAt: verification.officialUpdatedAt,
      checks: verification.checks
    },
    national: buildLocation('BR'),
    locations
  };
}

module.exports = { buildResults, RECOUNT_DIR, ROOT };
