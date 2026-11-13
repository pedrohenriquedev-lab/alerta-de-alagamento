
"use strict";

const express = require("express");
const cors = require("cors");
const dns = require("node:dns");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// SUPABASE
// ==========================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error(
    "Configure SUPABASE_URL e SUPABASE_SECRET_KEY nas variáveis de ambiente."
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY
);

app.use(cors());
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// CACHE EM MEMÓRIA
// ==========================================

const cache = new Map();

function obterCache(chave) {
  const item = cache.get(chave);

  if (!item) return null;

  if (Date.now() > item.expiraEm) {
    cache.delete(chave);
    return null;
  }

  return item.valor;
}

function salvarCache(chave, valor, duracaoMs) {
  if (cache.size > 500) {
    const primeiraChave = cache.keys().next().value;
    cache.delete(primeiraChave);
  }

  cache.set(chave, {
    valor,
    expiraEm: Date.now() + duracaoMs
  });
}

const CACHE_CLIMA = 5 * 60 * 1000;
const CACHE_GEOCODIFICACAO = 24 * 60 * 60 * 1000;

// ==========================================
// CONTROLE DE CONSULTAS AO NOMINATIM
// ==========================================

let filaNominatim = Promise.resolve();
let ultimaConsultaNominatim = 0;

function aguardar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function consultarNominatim(url) {
  const tarefa = filaNominatim.then(async () => {
    const tempoDecorrido = Date.now() - ultimaConsultaNominatim;
    const espera = Math.max(0, 1100 - tempoDecorrido);

    if (espera > 0) {
      await aguardar(espera);
    }

    ultimaConsultaNominatim = Date.now();

    return requisicao(url, {
      headers: {
        "User-Agent": "AlertaDeAlagamento/1.0 (projeto educacional)",
        "Accept-Language": "pt-BR"
      }
    });
  });

  filaNominatim = tarefa.catch(() => {});
  return tarefa;
}

// ==========================================
// REQUISIÇÕES EXTERNAS COM NOVAS TENTATIVAS
// ==========================================

async function requisicao(url, opcoes = {}) {
  const tentativas = 3;
  let ultimoErro;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resposta = await fetch(url, {
        ...opcoes,
        signal: AbortSignal.timeout(15000)
      });

      if (!resposta.ok) {
        if (
          resposta.status === 429 ||
          resposta.status === 502 ||
          resposta.status === 503 ||
          resposta.status === 504
        ) {
          throw new Error(
            resposta.status === 429
              ? "O serviço recebeu muitas consultas."
              : "O serviço externo está temporariamente indisponível."
          );
        }

        throw new Error(
          `O serviço externo respondeu com erro ${resposta.status}.`
        );
      }

      const dados = await resposta.json();

      // Algumas APIs retornam HTTP 200 mesmo quando estão sobrecarregadas.
      if (dados.error === true) {
        const motivo = String(dados.reason || "").toLowerCase();

        if (
          motivo.includes("overloaded") ||
          motivo.includes("temporarily unavailable")
        ) {
          throw new Error(
            "O serviço meteorológico está sobrecarregado."
          );
        }

        throw new Error(
          dados.reason || "O serviço externo retornou um erro."
        );
      }

      return dados;

    } catch (erro) {
      ultimoErro = erro;

      const mensagem = String(erro.message || "").toLowerCase();

      const erroTemporario =
        erro.name === "TimeoutError" ||
        erro.name === "AbortError" ||
        mensagem.includes("fetch failed") ||
        mensagem.includes("overloaded") ||
        mensagem.includes("sobrecarregado") ||
        mensagem.includes("temporariamente indisponível") ||
        mensagem.includes("muitas consultas");

      if (!erroTemporario || tentativa === tentativas) {
        break;
      }

      const intervalo = tentativa * 1500;

      console.log(
        `Tentativa ${tentativa} falhou. Nova tentativa em ${intervalo}ms.`
      );

      await aguardar(intervalo);
    }
  }

  const mensagem = String(ultimoErro?.message || "");

  if (
    ultimoErro?.name === "TimeoutError" ||
    ultimoErro?.name === "AbortError"
  ) {
    throw new Error(
      "O serviço externo demorou para responder. Tente novamente."
    );
  }

  if (mensagem.toLowerCase().includes("muitas consultas")) {
    throw new Error(
      "O serviço recebeu muitas consultas. Aguarde um pouco e tente novamente."
    );
  }

  if (
    mensagem.toLowerCase().includes("overloaded") ||
    mensagem.toLowerCase().includes("sobrecarregado")
  ) {
    throw new Error(
      "O serviço meteorológico está sobrecarregado. Tente novamente em alguns minutos."
    );
  }

  if (mensagem.toLowerCase().includes("temporariamente indisponível")) {
    throw new Error(mensagem);
  }

  if (mensagem.toLowerCase().includes("fetch failed")) {
    throw new Error(
      "Não foi possível conectar ao serviço externo."
    );
  }

  throw ultimoErro || new Error(
    "Não foi possível concluir a consulta externa."
  );
}

// ==========================================
// VALIDAÇÃO E TRATAMENTO DE ERROS
// ==========================================

function validarCoordenadas(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function mensagemErro(erro) {
  console.error("Erro no servidor:", erro);
  return erro.message || "Não foi possível concluir a consulta.";
}

function enviarErro(res, erro, statusPadrao = 502) {
  console.error("Erro:", erro);

  const mensagem = erro.message || "Não foi possível concluir a consulta.";

  if (
    mensagem.includes("muitas consultas") ||
    mensagem.includes("temporariamente indisponível") ||
    mensagem.includes("sobrecarregado")
  ) {
    return res.status(503).json({ erro: mensagem });
  }

  if (mensagem.includes("demorou para responder")) {
    return res.status(504).json({ erro: mensagem });
  }

  return res.status(statusPadrao).json({ erro: mensagem });
}

// ==========================================
// CONSULTA DE CIDADES
// ==========================================

async function buscarLocal(cidade) {
  const chave = `cidade:${cidade.toLowerCase()}`;
  const armazenado = obterCache(chave);

  if (armazenado) return armazenado;

  const url =
    "https://geocoding-api.open-meteo.com/v1/search" +
    `?name=${encodeURIComponent(cidade)}` +
    "&count=10&language=pt&format=json";

  const dados = await requisicao(url);

  if (!dados.results || dados.results.length === 0) {
    throw new Error("Cidade não encontrada.");
  }

  const local = dados.results[0];

  salvarCache(chave, local, CACHE_GEOCODIFICACAO);

  return local;
}

// ==========================================
// CONSULTA METEOROLÓGICA
// ==========================================

function montarUrlClima(latitude, longitude) {
  return (
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${latitude}` +
    `&longitude=${longitude}` +
    "&current=temperature_2m,relative_humidity_2m," +
    "precipitation,rain,showers,wind_speed_10m" +
    "&timezone=auto"
  );
}

function formatarClima(atual) {
  return {
    temperatura: atual.temperature_2m ?? null,
    umidade: atual.relative_humidity_2m ?? null,
    vento: atual.wind_speed_10m ?? null,
    precipitacao: atual.precipitation ?? null,
    chuva: atual.rain ?? null,
    pancadas: atual.showers ?? null
  };
}

async function consultarClima(latitude, longitude) {
  const chave = `clima:${latitude.toFixed(3)}:${longitude.toFixed(3)}`;
  const armazenado = obterCache(chave);

  if (armazenado) return armazenado;

  const dados = await requisicao(
    montarUrlClima(latitude, longitude)
  );

  if (!dados.current) {
    throw new Error("Dados meteorológicos indisponíveis.");
  }

  const clima = formatarClima(dados.current);

  salvarCache(chave, clima, CACHE_CLIMA);

  return clima;
}

// ==========================================
// ROTA DE SAÚDE
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    projeto: "Alerta de Alagamento",
    banco: "Supabase conectado"
  });
});

// ==========================================
// CLIMA POR CIDADE
// ==========================================

app.get("/weather/:cidade", async (req, res) => {
  try {
    const cidade = String(req.params.cidade || "").trim();

    if (!cidade) {
      return res.status(400).json({
        erro: "Informe uma cidade."
      });
    }

    const local = await buscarLocal(cidade);

    const clima = await consultarClima(
      Number(local.latitude),
      Number(local.longitude)
    );

    res.set("Cache-Control", "no-store");

    res.json({
      cidade: local.name,
      estado: local.admin1 || "",
      pais: local.country || "",
      latitude: Number(local.latitude),
      longitude: Number(local.longitude),
      clima
    });

  } catch (erro) {
    const status =
      erro.message === "Cidade não encontrada." ? 404 : 502;

    enviarErro(res, erro, status);
  }
});

// ==========================================
// CLIMA POR COORDENADAS
// ==========================================

app.get("/weather-location", async (req, res) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);

    if (!validarCoordenadas(latitude, longitude)) {
      return res.status(400).json({
        erro: "Latitude e longitude inválidas."
      });
    }

    const chave =
      `clima-completo:${latitude.toFixed(3)}:${longitude.toFixed(3)}`;

    let dados = obterCache(chave);

    if (!dados) {
      dados = await requisicao(
        montarUrlClima(latitude, longitude)
      );

      if (!dados.current) {
        throw new Error("Dados meteorológicos indisponíveis.");
      }

      salvarCache(chave, dados, CACHE_CLIMA);
    }

    res.json({
      latitude,
      longitude,
      horario: dados.current.time,
      timezone: dados.timezone,
      clima: formatarClima(dados.current)
    });

  } catch (erro) {
    enviarErro(res, erro);
  }
});

// ==========================================
// GPS: COORDENADAS PARA CIDADE E BAIRRO
// ==========================================

app.get("/reverse-geocode", async (req, res) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);

    if (!validarCoordenadas(latitude, longitude)) {
      return res.status(400).json({
        erro: "Coordenadas inválidas."
      });
    }

    const chave =
      `reverse:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;

    let dados = obterCache(chave);

    if (!dados) {
      const url =
        "https://nominatim.openstreetmap.org/reverse" +
        `?lat=${latitude}&lon=${longitude}` +
        "&format=jsonv2&accept-language=pt-BR";

      dados = await consultarNominatim(url);

      salvarCache(chave, dados, CACHE_GEOCODIFICACAO);
    }

    const endereco = dados.address || {};

    const nome =
      endereco.city ||
      endereco.town ||
      endereco.municipality ||
      endereco.village ||
      endereco.county;

    if (!nome) {
      return res.status(404).json({
        erro: "Não foi possível identificar sua cidade."
      });
    }

    res.json({
      nome,
      bairro:
        endereco.suburb ||
        endereco.neighbourhood ||
        endereco.quarter ||
        "",
      estado: endereco.state || "",
      pais: endereco.country || "Brasil",
      latitude,
      longitude
    });

  } catch (erro) {
    enviarErro(res, erro);
  }
});

// ==========================================
// LOCALIZAR BAIRRO
// ==========================================

app.get("/geocode/:bairro", async (req, res) => {
  try {
    const bairro = String(req.params.bairro || "").trim();
    const cidade = String(req.query.cidade || "").trim();

    if (!bairro || !cidade) {
      return res.status(400).json({
        erro: "Informe o bairro e a cidade."
      });
    }

    const consulta = `${bairro}, ${cidade}, Brasil`;
    const chave = `bairro:${consulta.toLowerCase()}`;

    let dados = obterCache(chave);

    if (!dados) {
      const url =
        "https://nominatim.openstreetmap.org/search" +
        `?q=${encodeURIComponent(consulta)}` +
        "&format=jsonv2&limit=1&countrycodes=br";

      dados = await consultarNominatim(url);

      if (!dados.length) {
        return res.status(404).json({
          erro: "Não foi possível localizar esse bairro."
        });
      }

      dados = {
        latitude: Number(dados[0].lat),
        longitude: Number(dados[0].lon),
        nome: dados[0].display_name
      };

      salvarCache(chave, dados, CACHE_GEOCODIFICACAO);
    }

    res.json(dados);

  } catch (erro) {
    enviarErro(res, erro);
  }
});

// ==========================================
// LISTAR OCORRÊNCIAS
// ==========================================

app.get("/api/occurrences", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("occurrences")
      .select("*")
      .order("dataRegistro", { ascending: false });

    if (error) {
      console.error("Erro ao buscar ocorrências:", error);

      return res.status(500).json({
        erro: "Não foi possível buscar os relatos comunitários."
      });
    }

    res.set("Cache-Control", "no-store");
    res.json(data || []);

  } catch (erro) {
    enviarErro(res, erro, 500);
  }
});

// ==========================================
// CADASTRAR OCORRÊNCIA
// ==========================================

app.post("/api/occurrences", async (req, res) => {
  try {
    const {
      nome,
      cidade,
      bairro,
      nivel,
      descricao,
      latitude,
      longitude,
      estado,
      pais
    } = req.body || {};

    const niveisValidos = ["Alto", "Médio", "Baixo"];

    if (
      typeof nome !== "string" ||
      typeof cidade !== "string" ||
      typeof bairro !== "string" ||
      !nome.trim() ||
      !cidade.trim() ||
      !bairro.trim() ||
      !niveisValidos.includes(nivel)
    ) {
      return res.status(400).json({
        erro: "Preencha corretamente nome, cidade, bairro e nível."
      });
    }

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!validarCoordenadas(lat, lon)) {
      return res.status(400).json({
        erro: "As coordenadas do relato são inválidas."
      });
    }

    if (
      typeof descricao !== "string" ||
      descricao.length > 1000 ||
      nome.length > 100 ||
      cidade.length > 100 ||
      bairro.length > 100
    ) {
      return res.status(400).json({
        erro: "Os campos enviados excedem o tamanho permitido."
      });
    }

    const novaOcorrencia = {
      nome: nome.trim(),
      cidade: cidade.trim(),
      bairro: bairro.trim(),
      nivel,
      descricao: descricao.trim(),
      latitude: lat,
      longitude: lon,
      estado: String(estado || "").trim(),
      pais: String(pais || "").trim()
    };

    const { data, error } = await supabase
      .from("occurrences")
      .insert(novaOcorrencia)
      .select()
      .single();

    if (error) {
      console.error("Erro ao cadastrar ocorrência:", error);

      return res.status(500).json({
        erro: "Não foi possível registrar o relato no banco de dados."
      });
    }

    res.status(201).json({
      mensagem: "Relato registrado com sucesso.",
      ocorrencia: data
    });

  } catch (erro) {
    enviarErro(res, erro, 500);
  }
});

// ==========================================
// ROTAS DA API NÃO ENCONTRADAS
// ==========================================

app.use("/api", (req, res) => {
  res.status(404).json({
    erro: "Rota da API não encontrada."
  });
});

// ==========================================
// TRATAMENTO GERAL DE ERROS
// ==========================================

app.use((erro, req, res, next) => {
  console.error("Erro não tratado:", erro);

  if (res.headersSent) {
    return next(erro);
  }

  res.status(500).json({
    erro: "Ocorreu um erro interno no servidor."
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log(`Alerta de Alagamento rodando na porta ${PORT}`);
  console.log("Integração com Supabase configurada.");
});
