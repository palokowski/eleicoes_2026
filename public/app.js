const summaryEl = document.getElementById('summary');
const stateTableEl = document.getElementById('state-table');
const button = document.getElementById('load-results');
const locationSelect = document.getElementById('location-select');
const candidateTable = document.getElementById('candidate-table');
const chartTitle = document.getElementById('chart-title');
const sourceNote = document.getElementById('source-note');
const modeLabel = document.getElementById('mode-label');
const statusBanner = document.getElementById('status-banner');
const verificationSection = document.getElementById('verification-section');
const downloadsSection = document.getElementById('downloads-section');
let chart;
let results;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('pt-BR') : 'data não informada';
}

function percent(value, total) {
  return total ? `${((value / total) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : '0,00%';
}

function renderStatus(data) {
  const verified = data.mode === 'recontagem';
  modeLabel.textContent = verified ? 'Recontagem independente dos boletins de urna · 1º turno' : 'Resultado oficial do TSE · 1º turno';
  statusBanner.hidden = false;
  statusBanner.classList.toggle('verified', verified);
  statusBanner.innerHTML = verified
    ? `<strong>Recontagem igual ao resultado oficial do TSE.</strong>
       ${formatNumber(data.verification.totals.buFiles)} boletins de urna recontados, com ${formatNumber(data.verification.totals.validVotesFromBUs)} votos válidos.
       Os votos de cada candidato batem com o TSE no Brasil, em todos os estados e no exterior.`
    : `<strong>Recontagem em andamento.</strong>
       Os números abaixo são os oficiais publicados pelo TSE. A recontagem dos boletins de urna ainda não foi concluída e conferida.`;
}

function renderSummary(data) {
  const total = data.national;

  summaryEl.innerHTML = `
    <div class="kpi">
      <div class="label">Votos válidos</div>
      <div class="value">${formatNumber(total.validVotes)}</div>
    </div>
    <div class="kpi">
      <div class="label">Comparecimento</div>
      <div class="value">${formatNumber(total.turnout)} <small>${percent(total.turnout, total.electorate)}</small></div>
    </div>
    <div class="kpi">
      <div class="label">Abstenção</div>
      <div class="value">${formatNumber(total.abstention)} <small>${percent(total.abstention, total.electorate)}</small></div>
    </div>
    <div class="kpi">
      <div class="label">Brancos · nulos</div>
      <div class="value">${formatNumber(total.blankVotes)} · ${formatNumber(total.nullVotes)}</div>
    </div>
  `;
}

function renderLocation(locationId) {
  const location = locationId === 'br'
    ? results.national
    : results.locations.find((item) => item.id === locationId);
  if (!location) return;

  chartTitle.textContent = location.name === 'Brasil' ? 'Brasil · totalização geral' : `${location.name}${location.uf === 'ZZ' ? '' : ` · ${location.uf}`}`;
  candidateTable.innerHTML = location.candidates
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.number)}</td>
        <td>${escapeHtml(item.candidate)}</td>
        <td>${escapeHtml(item.party)}</td>
        <td class="num">${formatNumber(item.votes)}</td>
        <td class="num">${item.percentage.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>
      </tr>
    `)
    .join('');

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('votes-chart'), {
    type: 'bar',
    data: {
      labels: location.candidates.map((item) => item.candidate),
      datasets: [{
        data: location.candidates.map((item) => item.percentage),
        backgroundColor: ['#087f5b', '#d9480f', '#1971c2', '#b08900', '#7048e8', '#c2255c'],
        borderRadius: 3,
        barThickness: 22
      }]
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
              const candidate = location.candidates[context.dataIndex];
              return `${formatNumber(candidate.votes)} votos · ${candidate.percentage.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: (value) => `${value}%` }, grid: { color: '#e5e4df' } },
        y: { grid: { display: false } }
      }
    }
  });
}

function renderStateTable(data) {
  stateTableEl.innerHTML = data.locations
    .map((item) => `
      <tr class="location-row" data-location="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Ver resultado de ${escapeHtml(item.name)}">
        <td>${escapeHtml(item.uf)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="num">${formatNumber(item.validVotes)}</td>
        <td class="num">${formatNumber(item.turnout)}</td>
        <td>${item.winner ? `${escapeHtml(item.winner.candidate)} (${escapeHtml(item.winner.party)})` : '—'}</td>
      </tr>
    `)
    .join('');

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

  const statusText = { igual: '✓ Igual', diferente: '✗ Diferente', pendente: '… Pendente' };
  const statusClass = { igual: 'mark-ok', diferente: 'mark-falha', pendente: 'mark-pendente' };
  document.getElementById('verification-table').innerHTML = verification.locations
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.name)}${item.location === 'BR' || item.location === 'ZZ' ? '' : ` (${escapeHtml(item.location)})`}</td>
        <td class="num">${formatNumber(item.officialValid)}</td>
        <td class="num">${item.recountValid == null ? '—' : formatNumber(item.recountValid)}</td>
        <td class="${statusClass[item.status]}">${statusText[item.status]}</td>
      </tr>
      ${item.differences.map((diff) => `
        <tr class="diff-row">
          <td colspan="4">${escapeHtml(diff.candidate)}: TSE ${formatNumber(diff.official)} · BUs ${formatNumber(diff.recount)} (${diff.difference > 0 ? '+' : ''}${formatNumber(diff.difference)})</td>
        </tr>
      `).join('')}
    `)
    .join('');

  document.getElementById('verification-note').textContent =
    `Conferido em ${formatDate(verification.checkedAt)}. Resultado oficial do TSE de ${formatDate(verification.officialUpdatedAt)}.`;
}

function renderDownloads(files) {
  downloadsSection.hidden = !files?.length;
  if (!files?.length) return;
  document.getElementById('downloads').innerHTML = files
    .map((file) => `<li><a href="dados/${encodeURIComponent(file.name)}" download>${escapeHtml(file.name)}</a> · ${escapeHtml(file.label)}</li>`)
    .join('');
}

async function loadResults() {
  button.disabled = true;
  button.textContent = 'Carregando…';
  summaryEl.innerHTML = '<div class="loading">Lendo os resultados…</div>';

  try {
    const response = await fetch('data/results.json', { cache: 'no-cache' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || 'Erro ao ler os arquivos de resultados.');
    }

    results = data;
    renderStatus(data);
    renderSummary(data);
    renderStateTable(data);
    locationSelect.innerHTML = '<option value="br">Brasil · totalização geral</option>' + data.locations
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.uf === 'ZZ' ? '' : ` (${escapeHtml(item.uf)})`}</option>`)
      .join('');
    locationSelect.disabled = false;
    locationSelect.value = 'br';
    renderLocation('br');
    renderVerification(data.verification);
    renderDownloads(data.downloads);
    sourceNote.textContent = `${data.source} Atualizado em ${formatDate(data.generatedAt)}.`;
  } catch (error) {
    summaryEl.innerHTML = `<div class="loading">Erro: ${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Atualizar contagem';
  }
}

button.addEventListener('click', loadResults);
locationSelect.addEventListener('change', () => renderLocation(locationSelect.value));
loadResults();
