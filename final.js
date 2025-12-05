import * as fs from 'node:fs';
import * as http from 'node:http';
import { google } from 'googleapis';
import * as url from 'node:url';

// IMPORTAÇÃO CORRIGIDA para usar 'open' de forma moderna (necessária para autenticação)
const open = (...args) => import('open').then(mod => mod.default(...args));

// Antigas
import { GoogleGenAI } from "@google/genai";
import axios from 'axios';
import * as fsp from 'node:fs/promises'; // Importa 'fs/promises' com prefixo 'node:'
import * as dotenv from 'dotenv';
import { log, initialize } from './logger.js';

// Carrega variáveis de ambiente do arquivo .env
dotenv.config();

// Inicialização do SDK do Google Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- CONFIGURAÇÕES GLOBAIS ---
// 🚨 NOVO: Variáveis para o fluxo de autenticação do Google
const TOKEN_PATH = "C:\\dev\\nodejs\\_credenciais\\token.json";
const CREDENTIALS_PATH = "C:\\dev\\nodejs\\_credenciais\\credentials.json";

// Configurações antigas do IMAP REMOVIDAS.

const SENDER_TO_MONITOR = process.env.SENDER_TO_MONITOR || 'alerta@system.com';
const NOBREAK_URL = 'http://192.168.254.77/#/status/bateria/'; 
const XCOPY_LOG_PATH = 'www_files'; 

// =========================================================================
// 0. 🔑 FUNÇÕES DE AUTENTICAÇÃO DO GMAIL (Migradas do index.js)
// =========================================================================

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error(`\n❌ ERRO: Arquivo ${CREDENTIALS_PATH} não encontrado. Necessário para a autenticação do Gmail.`);
      process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
}

async function authorize() {
  const { client_secret, client_id, redirect_uris } = loadCredentials().installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] // Geralmente http://localhost
  );

  if (fs.existsSync(TOKEN_PATH)) {
    console.log("Token de autenticação existente encontrado. Usando...");
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2Client;
  }

  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.readonly"]
    });

    console.log("\n👉 Abrindo navegador para autenticação do Gmail (Google OAuth)...");
    open(authUrl);

    const server = http.createServer(async (req, res) => {
      // Cria a URL base para o parser para evitar problemas com req.url
      const qs = new url.URL(req.url, "http://localhost").searchParams;
      const code = qs.get("code");

      if (!code) {
        res.end("Código não encontrado na URL de retorno do OAuth.");
        return;
      }

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

        res.end("Autenticação concluída! Pode fechar esta página.");
        server.close();
        resolve(oAuth2Client);
      } catch (err) {
        reject(new Error(`Erro ao obter token do OAuth: ${err.message}`));
      }
    });
    // O porto 80 é o padrão no index.js, mas deve coincidir com o redirect_uris[0]
    server.listen(80, () => console.log("Aguardando resposta OAuth no http://localhost..."));
  });
}


// =========================================================================
// 1. 🤖 FUNÇÃO PRINCIPAL DE COMUNICAÇÃO COM GEMINI (Core)
// =========================================================================

/**
 * Envia conteúdo e uma pergunta para o modelo Gemini para análise.
 * @param {string} content O conteúdo (HTML, email, log) a ser analisado.
 * @param {string} prompt A pergunta ou instrução específica para o Gemini.
 * @returns {Promise<string>} A resposta analisada do Gemini.
 */
async function analyzeContentWithGemini(content, prompt) {
  const fullPrompt = `ANALISE O SEGUINTE CONTEÚDO E RESPONDA À PERGUNTA:\n\nCONTEÚDO:\n---\n${content}\n---\n\nPERGUNTA:\n${prompt}`;
  
  // Calcula a contagem aproximada de tokens para fins de log
  const tokenCount = Math.ceil(fullPrompt.length / 4); 
  console.log(`\n--- Iniciando Análise Gemini --- (Tokens Estimados: ~${tokenCount})`);
  log('info', `Gemini Request: ${prompt}`);
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: fullPrompt,
      config: {
        // Reduz a criatividade para respostas mais factuais e concisas
        temperature: 0.1, 
      }
    });

    log('info', `Gemini Response: ${response.text.trim()}`);
    return response.text.trim();
  } catch (error) {
    console.error("❌ ERRO ao comunicar com o Gemini:", error.message);
    log('error', `Gemini Error: ${error.message}`);
    return "Erro na análise: Não foi possível obter resposta do Gemini.";
  }
}


// =========================================================================
// 2. ⚡️ FUNÇÃO PARA ANÁLISE DE HTML (Intranet/Nobreak)
// =========================================================================

/**
 * Lê o HTML de uma página e usa o Gemini para verificar o status do nobreak.
 * @param {string} url O endereço da página de status do nobreak.
 * @returns {Promise<string>} A resposta do Gemini sobre o status.
 */
async function checkNobreakStatus(url) {
  console.log(`\n### ⚡️ Análise de Nobreak: Lendo URL: ${url}`);
  log('info', `Checking Nobreak status at ${url}`);
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const htmlContent = response.data;

    const prompt = "No código HTML fornecido, verifique se o status do nobreak indica que ele está operando 'na bateria' ou 'em bypass/rede normal'. Diga se o status é de alerta (bateria) ou normal. Responda de forma concisa.";
    
    const analysisResult = await analyzeContentWithGemini(htmlContent, prompt);
    log('info', `Nobreak status: ${analysisResult}`);
    
    return analysisResult;

  } catch (error) {
    console.error(`❌ ERRO ao ler a página da intranet: ${error.message}`);
    log('error', `Error checking Nobreak status: ${error.message}`);
    return "Erro: Não foi possível acessar a URL da intranet ou timeout.";
  }
}


// =========================================================================
// 3. 📧 FUNÇÃO PARA ANÁLISE DE CORPO DE EMAIL (Agora usando Gmail/Google API)
// =========================================================================

/**
 * Conecta-se ao Gmail, busca o último e-mail de um remetente e verifica erros.
 * @returns {Promise<string>} A resposta do Gemini sobre o erro encontrado.
 */
async function checkEmailForErrors() {
    console.log(`\n### 📧 Análise de E-mail: Buscando de ${SENDER_TO_MONITOR} via Gmail API`);
    log('info', `Checking email from ${SENDER_TO_MONITOR}`);
    
    let auth;
    try {
        auth = await authorize();
    } catch (e) {
        log('error', `Authentication error: ${e.message}`);
        return `Erro de Autenticação: ${e.message}`;
    }

    const gmail = google.gmail({ version: "v1", auth });
    
    try {
        // Busca a última mensagem do remetente específico
        const query = `from:${SENDER_TO_MONITOR}`;

        const res = await gmail.users.messages.list({
            userId: "me",
            maxResults: 1, // Queremos apenas a mais recente
            q: query
        });

        if (!res.data.messages || res.data.messages.length === 0) {
            log('info', 'No new emails from the monitored sender.');
            return "Nenhum e-mail encontrado do remetente monitorado no Gmail.";
        }

        const msgId = res.data.messages[0].id;

        // Pega a mensagem completa (formato 'full')
        const m = await gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full" 
        });

        // 💡 FUNÇÃO AUXILIAR: Decodifica o corpo da mensagem
        function getEmailBody(payload) {
            let body = '';
            
            // Tenta obter o corpo de texto simples
            const part = payload.parts ? 
                         payload.parts.find(p => p.mimeType === 'text/plain') :
                         (payload.mimeType === 'text/plain' ? payload : null);

            if (part && part.body && part.body.data) {
                // O corpo do Gmail API é Base64URL, então precisa de substituições
                const base64 = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
                body = Buffer.from(base64, 'base64').toString('utf-8');
            } else if (payload.body && payload.body.data) {
                 // Fallback para corpo sem partes (raro, mas pode acontecer)
                 const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
                 body = Buffer.from(base64, 'base64').toString('utf-8');
            } else {
                body = 'Corpo do e-mail não acessível ou vazio.';
            }
            return body;
        }

        const emailBody = getEmailBody(m.data.payload);

        // Pega cabeçalhos para logar
        const headers = m.data.payload.headers;
        const subject = headers.find(h => h.name === "Subject")?.value;
        const date = headers.find(h => h.name === "Date")?.value;

        console.log(`   Assunto: ${subject}`);
        console.log(`   Data: ${date}`);
        console.log(`   Tamanho do corpo: ${emailBody.length} caracteres`);
        log('info', `Analyzing email: Subject: ${subject}, Date: ${date}`);

        const prompt = "Analise o corpo do e-mail. Determine se ele está reportando um erro no sistema. Se sim, qual é o erro principal? Responda de forma concisa 'SUCESSO (Sem Erros Reportados)' ou 'ERRO: [descrição do erro]'.";
        
        const analysisResult = await analyzeContentWithGemini(emailBody, prompt);
        log('info', `Email analysis result: ${analysisResult}`);
        
        return analysisResult;

    } catch (error) {
        console.error(`❌ ERRO ao processar e-mails: ${error.message}`);
        log('error', `Error processing emails: ${error.message}`);
        return "Erro: Falha ao se comunicar com a API do Gmail ou processar e-mails.";
    } 
    // Não há client.logout() na API do Google, a autenticação é persistente no token.json
}


// =========================================================================
// 4. 📄 FUNÇÃO PARA ANÁLISE DE ARQUIVO DE LOG (XCOPY) - COM CORREÇÃO DE TOKEN
// =========================================================================

/**
 * Lê um arquivo de log, TRUNCA para as últimas 500 linhas e usa o Gemini para verificar o sucesso.
 * @param {string} logFilePath O caminho completo para o arquivo de log do XCOPY.
 * @returns {Promise<string>} A resposta do Gemini sobre o sucesso da execução.
 */
async function checkXcopyLogSuccess(logFilePath) {
  console.log(`\n### 📄 Análise de Log: Lendo arquivo: ${logFilePath}`);
  log('info', `Checking xcopy log file: ${logFilePath}`);
  try {
    // Usa fsp (fs/promises)
    const logContent = await fsp.readFile(logFilePath, 'utf-8');

    // 💡 CORREÇÃO DE TOKEN: Trunca o log para as últimas 500 linhas
    const lines = logContent.split('\n');
    const maxLines = 500;
    
    // Usa apenas as últimas 500 linhas para reduzir a entrada
    const relevantContent = lines.slice(-maxLines).join('\n'); 
    
    console.log(`   (Log Truncado para as últimas ${relevantContent.split('\n').length} linhas)`);

    const prompt = "Analise o log do XCOPY fornecido. Determine se a operação foi concluída com sucesso (sem 'Access denied' ou erros graves). Responda apenas 'SUCESSO' se tudo estiver OK, ou 'FALHA: [motivo do erro mais relevante]' se houver problemas.";
    
    const analysisResult = await analyzeContentWithGemini(relevantContent, prompt);
    log('info', `Xcopy log analysis result: ${analysisResult}`);
    
    return analysisResult;

  } catch (error) {
    console.error(`❌ ERRO ao ler o arquivo de log: ${error.message}`);
    log('error', `Error reading xcopy log file: ${error.message}`);
    
    // Cria um arquivo de log de exemplo se ele não for encontrado (ENOENT)
    if (error.code === 'ENOENT') {
        const fakeLogContent = `10 Arquivo(s) copiado(s)\n0 Arquivo(s) ignorado(s)\n1 Erro(s) encontrado(s)\n`;
        // Usa fsp (fs/promises)
        await fsp.writeFile(logFilePath, fakeLogContent, 'utf-8');
        return `Erro: Arquivo de log não encontrado. Criado arquivo de exemplo '${logFilePath}'. Execute novamente.`;
    }
    return "Erro: Não foi possível ler o arquivo de log.";
  }
}


// =========================================================================
// 🚀 BLOCO DE EXECUÇÃO PRINCIPAL
// =========================================================================

async function main() {
    await initialize();
    console.log("==============================================");
    console.log("       SISTEMA DE MONITORAMENTO GEMINI        ");
    console.log("==============================================");
    
    let result;

    // O teste de E-mail agora **PRECISA** ser o primeiro a rodar,
    // pois a autenticação OAuth2 (abrir navegador) é assíncrona
    // e pode causar problemas se for no meio de outros testes.

    // --- 1. Teste de E-mail (NOVO: Usa Gmail API) ---
    result = await checkEmailForErrors();
    console.log("\n✅ RESULTADO FINAL (E-mail - Gmail API):");
    console.log(result);
    console.log("----------------------------------------------");
    
    // --- 2. Teste de Log ---
    result = await checkXcopyLogSuccess(XCOPY_LOG_PATH);
    console.log("\n✅ RESULTADO FINAL (Log XCOPY):");
    console.log(result);
    console.log("----------------------------------------------");

    // --- 3. Teste de HTML ---
    result = await checkNobreakStatus(NOBREAK_URL);
    console.log("\n✅ RESULTADO FINAL (Nobreak/HTML):");
    console.log(result);
    console.log("----------------------------------------------");
}

main().catch(err => {
    console.error("\n❌ ERRO FATAL NO SISTEMA PRINCIPAL:", err);
});