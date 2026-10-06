const summaryEl = document.getElementById('summary');
const summaryExtra = document.getElementById('summary-extra');
const stateTableEl = document.getElementById('state-table');
const locationSelect = document.getElementById('location-select');
const candidateTable = document.getElementById('candidate-table');
const chartTitle = document.getElementById('chart-title');
const locationNote = document.getElementById('location-note');
const sourceNote = document.getElementById('source-note');
const statusBanner = document.getElementById('status-banner');
const verificationSection = document.getElementById('verification-section');
const downloadsSection = document.getElementById('downloads-section');
let chart;
let results;

// Cores fixas por candidato: 22 (Flávio Bolsonaro) verde, 13 (Lula) vermelho.
const candidateColors = { 22: '#2b8a3e', 13: '#c92a2a' };
const otherColors = ['#1971c2', '#b08900', '#7048e8', '#0c8599', '#e8590c', '#868e96'];

function barColors(candidates) {
  let next = 0;
  return candidates.map((item) => candidateColors[Number(item.number)] || otherColors[next++ % otherColors.length]);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
}

function formatPercent(value, digits = 2) {
  return `${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'data não informada';
}

function formatSigned(value) {
  return `${value > 0 ? '+' : '−'}${formatNumber(Math.abs(value))}`;
}

function differenceCell(difference) {
  if (difference == null) return '<span class="muted">—</span>';
  if (difference === 0) return '<span class="diff-ok">✓ igual</span>';
  return `<span class="diff-bad">${formatSigned(difference)}</span>`;
}

function locationLabel(location) {
  return location.uf === 'BR' || location.uf === 'ZZ' ? location.name : `${location.name} (${location.uf})`;
}

// Agrupa as seções sem BU por município e zona: "Betim, zona 319: seções 58, 240 e 397".
function describeMissingBus(missingBus) {
  const groups = new Map();
  for (const item of missingBus) {
    const key = `${item.uf}|${item.municipality}|${item.zone}`;
    if (!groups.has(key)) groups.set(key, { ...item, sections: [] });
    groups.get(key).sections.push(Number(item.section));
  }
  return [...groups.values()].map((group) => {
    const sections = group.sections.sort((a, b) => a - b).map(String);
    const list = sections.length > 1 ? `${sections.slice(0, -1).join(', ')} e ${sections.at(-1)}` : sections[0];
    const municipality = group.municipality.charAt(0) + group.municipality.slice(1).toLowerCase();
    return `${municipality} (${group.uf}), zona ${Number(group.zone)}: seç${sections.length > 1 ? 'ões' : 'ão'} ${list}`;
  });
}

function renderStatus(data) {
  statusBanner.hidden = false;
  statusBanner.className = 'status-banner';
  const national = data.national;

  if (!data.recount) {
    statusBanner.innerHTML = '<strong>Recontagem em andamento.</strong> Por enquanto, a página mostra só o resultado oficial do TSE.';
    return;
  }
  if (data.verified) {
    statusBanner.classList.add('verified');
    statusBanner.innerHTML = `<strong>A recontagem dos boletins de urna é igual ao resultado do TSE.</strong>
      ${formatNumber(data.recount.busRead)} boletins recontados. Os votos de cada candidato batem no Brasil, em todos os estados e no exterior.`;
    return;
  }

  const differentPlaces = data.locations.filter((item) => item.status === 'diferente').map((item) => item.name);
  const placesText = differentPlaces.length > 1 ? `${differentPlaces.slice(0, -1).join(', ')} e ${differentPlaces.at(-1)}` : differentPlaces[0];
  const gap = Math.abs(national.difference || 0);
  const missing = national.missingBus.length;
  statusBanner.innerHTML = `<strong>A recontagem bate com o TSE em ${data.recount.matchingLocations} de ${data.recount.totalLocations} locais.</strong>
    ${gap ? `A diferença é de ${formatNumber(gap)} votos válidos (${formatPercent(gap / national.officialValid * 100, 3)} do total)${placesText ? `, em ${escapeHtml(placesText)}` : ''}.` : ''}
    ${missing ? `Ela vem de ${missing} seções cujos boletins de urna o TSE ainda não publicou, e que por isso não puderam ser recontadas.` : ''}`;
}

function renderSummary(data) {
  const national = data.national;
  const recounted = national.recountValid != null;
  summaryEl.innerHTML = `
    <div class="kpi">
      <div class="label">Votos válidos · TSE</div>
      <div class="value">${formatNumber(national.officialValid)}</div>
    </div>
    <div class="kpi">
      <div class="label">Votos válidos · boletins de urna</div>
      <div class="value">${recounted ? formatNumber(national.recountValid) : '—'}</div>
    </div>
    <div class="kpi">
      <div class="label">Diferença</div>
      <div class="value">${recounted ? differenceCell(national.difference) : '—'}</div>
    </div>
    <div class="kpi">
      <div class="label">Boletins de urna lidos</div>
      <div class="value">${data.recount ? `${formatNumber(data.recount.busRead)} <small>de ${formatNumber(data.recount.busExpected)}</small>` : '—'}</div>
    </div>
  `;
  summaryExtra.textContent = `Números do TSE: comparecimento ${formatNumber(national.turnout)} (${formatPercent(national.turnout / national.electorate * 100)}) · abstenção ${formatNumber(national.abstention)} · brancos ${formatNumber(national.blankVotes)} · nulos ${formatNumber(national.nullVotes)}.`;
}

function renderLocation(locationId) {
  const location = locationId === 'br' ? results.national : results.locations.find((item) => item.id === locationId);
  if (!location) return;

  chartTitle.textContent = location.uf === 'BR' ? 'Brasil · total' : locationLabel(location);
  candidateTable.innerHTML = location.candidates
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.number)}</td>
        <td>${escapeHtml(item.candidate)} <span class="party">${escapeHtml(item.party)}</span></td>
        <td class="num">${formatPercent(item.percentage)}</td>
        <td class="num col-tse">${formatNumber(item.official)}</td>
        <td class="num col-bu">${item.recount == null ? '—' : formatNumber(item.recount)}</td>
        <td class="num">${differenceCell(item.difference)}</td>
      </tr>
    `)
    .join('') + `
      <tr class="total-row">
        <td></td>
        <td>Total de votos válidos</td>
        <td class="num">100,00%</td>
        <td class="num col-tse">${formatNumber(location.officialValid)}</td>
        <td class="num col-bu">${location.recountValid == null ? '—' : formatNumber(location.recountValid)}</td>
        <td class="num">${differenceCell(location.difference)}</td>
      </tr>`;

  if (location.status === 'igual') {
    locationNote.hidden = false;
    locationNote.className = 'location-note ok';
    locationNote.textContent = `✓ Em ${location.uf === 'BR' ? 'todo o Brasil' : location.name}, os votos de todos os candidatos nos boletins de urna são iguais aos do TSE.`;
  } else if (location.status === 'diferente') {
    locationNote.hidden = false;
    locationNote.className = 'location-note bad';
    locationNote.innerHTML = location.missingBus.length
      ? `<strong>Por que há diferença:</strong> ${location.missingBus.length} seç${location.missingBus.length > 1 ? 'ões' : 'ão'} sem boletim de urna publicado pelo TSE, que por isso não ${location.missingBus.length > 1 ? 'puderam' : 'pôde'} ser recontada${location.missingBus.length > 1 ? 's' : ''}:
         <ul>${describeMissingBus(location.missingBus).map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
      : '<strong>Há diferença</strong> entre os boletins de urna e o resultado do TSE neste local.';
  } else {
    locationNote.hidden = false;
    locationNote.className = 'location-note';
    locationNote.textContent = 'A recontagem deste local ainda não foi concluída.';
  }

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('votes-chart'), {
    type: 'bar',
    data: {
      labels: location.candidates.map((item) => item.candidate),
      datasets: [{ data: location.candidates.map((item) => item.percentage), backgroundColor: barColors(location.candidates), borderRadius: 3, barThickness: 22 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const item = location.candidates[context.dataIndex];
              const lines = [`${formatPercent(item.percentage)} dos votos válidos`, `TSE: ${formatNumber(item.official)} votos`];
              if (item.recount != null) lines.push(`Boletins de urna: ${formatNumber(item.recount)} votos`);
              return lines;
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: (value) => `${value}%` }, grid: { color: '#e5e4df' } },
        y: {
          grid: { display: false },
          // Em telas estreitas, encurta os nomes para não cortar o rótulo.
          ticks: { callback(value) { const label = this.getLabelForValue(value); return window.innerWidth < 600 && label.length > 16 ? `${label.slice(0, 15)}…` : label; } }
        }
      }
    }
  });
}

function renderStateTable(data) {
  stateTableEl.innerHTML = data.locations
    .map((item) => `
      <tr class="location-row${item.winner ? ` winner-${Number(item.winner.number)}` : ''}" data-location="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Ver votos por candidato em ${escapeHtml(item.name)}">
        <td>${escapeHtml(item.uf)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="num col-tse">${formatNumber(item.officialValid)}</td>
        <td class="num col-bu">${item.recountValid == null ? '—' : formatNumber(item.recountValid)}</td>
        <td class="num">${differenceCell(item.difference)}</td>
        <td>${item.winner ? `${escapeHtml(item.winner.candidate)} <span class="party">${escapeHtml(item.winner.party)}</span>` : '—'}</td>
      </tr>
    `)
    .join('') + `
      <tr class="total-row">
        <td>BR</td>
        <td>Brasil · total</td>
        <td class="num col-tse">${formatNumber(data.national.officialValid)}</td>
        <td class="num col-bu">${data.national.recountValid == null ? '—' : formatNumber(data.national.recountValid)}</td>
        <td class="num">${differenceCell(data.national.difference)}</td>
        <td>${data.national.winner ? `${escapeHtml(data.national.winner.candidate)} <span class="party">${escapeHtml(data.national.winner.party)}</span>` : '—'}</td>
      </tr>`;

  stateTableEl.querySelectorAll('.location-row').forEach((row) => {
    const selectLocation = () => {
      locationSelect.value = row.dataset.location;
      renderLocation(locationSelect.value);
      document.querySelector('.chart-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    row.addEventListener('click', selectLocation);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectLocation();
      }
    });
  });
}

function renderVerification(verification) {
  verificationSection.hidden = !verification;
  if (!verification) return;
  const marks = { ok: '✓', aviso: '!', falha: '✗' };
  document.getElementById('check-list').innerHTML = verification.checks
    .map((check) => `
      <li>
        <span class="mark-${check.level}" aria-label="${check.level}">${marks[check.level]}</span>
        <span>${escapeHtml(check.label)}<span class="detail">${escapeHtml(check.detail)}</span></span>
      </li>
    `)
    .join('');
  document.getElementById('verification-note').textContent =
    `Conferido em ${formatDate(verification.checkedAt)} com o resultado oficial do TSE de ${formatDate(verification.officialUpdatedAt)}.`;
}

function renderDownloads(files) {
  downloadsSection.hidden = !files?.length;
  if (!files?.length) return;
  document.getElementById('downloads').innerHTML = files
    .map((file) => `<li><a href="dados/${encodeURIComponent(file.name)}" download>${escapeHtml(file.name)}</a> · ${escapeHtml(file.label)}</li>`)
    .join('');
}

async function loadResults() {
  try {
    const response = await fetch('data/results.json', { cache: 'no-cache' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.details || 'Erro ao ler os arquivos de resultados.');

    results = data;
    renderStatus(data);
    renderSummary(data);
    renderStateTable(data);
    locationSelect.innerHTML = '<option value="br">Brasil · total</option>' + data.locations
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(locationLabel(item))}</option>`)
      .join('');
    locationSelect.disabled = false;
    locationSelect.value = 'br';
    renderLocation('br');
    renderVerification(data.verification);
    renderDownloads(data.downloads);
    sourceNote.textContent = `Resultado oficial do TSE atualizado em ${formatDate(data.officialUpdatedAt)}.${data.recountGeneratedAt ? ` Boletins de urna recontados em ${formatDate(data.recountGeneratedAt)}.` : ''} As porcentagens são do resultado do TSE.`;
  } catch (error) {
    summaryEl.innerHTML = `<div class="loading">Erro: ${escapeHtml(error.message)}</div>`;
  }
}

locationSelect.addEventListener('change', () => renderLocation(locationSelect.value));
loadResults();
