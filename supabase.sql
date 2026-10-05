-- Rode uma vez no SQL Editor do Supabase.

create table if not exists votos_presidente (
  turno          int    not null,
  nivel          text   not null,          -- 'br', 'uf' ou 'mu'
  uf             text   not null,          -- 'BR', sigla da UF ou 'ZZ' (exterior)
  cd_municipio   text   not null default '',
  municipio      text,
  numero         int    not null,
  candidato      text,
  partido        text,
  votos          bigint not null default 0,
  pct_validos    numeric,
  atualizado_em  timestamptz,
  primary key (turno, nivel, uf, cd_municipio, numero)
);

create table if not exists apuracao_presidente (
  turno          int    not null,
  nivel          text   not null,
  uf             text   not null,
  cd_municipio   text   not null default '',
  municipio      text,
  pct_secoes     numeric,                  -- % de secoes totalizadas
  eleitorado     bigint,
  comparecimento bigint,
  abstencao      bigint,
  validos        bigint,
  brancos        bigint,
  nulos          bigint,
  atualizado_em  timestamptz,
  primary key (turno, nivel, uf, cd_municipio)
);

create index if not exists votos_presidente_uf on votos_presidente (turno, nivel, uf);

-- Leitura publica (para o site usar a chave anon); escrita so com a service_role.
alter table votos_presidente    enable row level security;
alter table apuracao_presidente enable row level security;
create policy "leitura publica" on votos_presidente    for select using (true);
create policy "leitura publica" on apuracao_presidente for select using (true);
