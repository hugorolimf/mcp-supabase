#!/usr/bin/env node

/**
 * MCP Server — Supabase SQL + Edge Functions
 *
 * Conecta a UMA instância Supabase (cloud ou self-hosted) e permite
 * gerenciar Edge Functions via SSH na VPS.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Client as SSHClient } from 'ssh2';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

// ═══════════════════════════════════════════════════════════
// Configuração Supabase (única instância)
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INSTANCE_NAME = process.env.SUPABASE_INSTANCE_NAME || 'default';
const DOCKER_PATH = process.env.SUPABASE_DOCKER_PATH;
const FUNCTIONS_CONTAINER = process.env.SUPABASE_FUNCTIONS_CONTAINER;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '❌ ERRO: SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.\n' +
      '   Configure o arquivo .env'
  );
  process.exit(1);
}

if (!DOCKER_PATH || !FUNCTIONS_CONTAINER) {
  console.error(
    '❌ ERRO: SUPABASE_DOCKER_PATH e SUPABASE_FUNCTIONS_CONTAINER são obrigatórios.\n' +
      '   Configure o arquivo .env'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ═══════════════════════════════════════════════════════════
// Configuração SSH
// ═══════════════════════════════════════════════════════════

const SSH_CONFIG = {
  host: process.env.SSH_HOST,
  port: parseInt(process.env.SSH_PORT || '22', 10),
  username: process.env.SSH_USERNAME,
  password: process.env.SSH_PASSWORD,
  privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH,
  passphrase: process.env.SSH_PASSPHRASE,
};

function getSSHConfig() {
  const cfg = { ...SSH_CONFIG };
  if (cfg.privateKeyPath) {
    const pkPath = cfg.privateKeyPath.replace(/^~/, homedir());
    cfg.privateKey = readFileSync(pkPath);
  }
  if (!cfg.host || !(cfg.password || cfg.privateKey)) {
    throw new Error(
      'SSH não configurado. Defina SSH_HOST, SSH_USERNAME e SSH_PASSWORD (ou SSH_PRIVATE_KEY_PATH).'
    );
  }
  return cfg;
}

function sshExec(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const cfg = getSSHConfig();
    let stdout = '';
    let stderr = '';
    let timer;

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              stream.close();
              conn.end();
              reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }

          stream
            .on('close', (code) => {
              clearTimeout(timer);
              conn.end();
              resolve({ stdout, stderr, code });
            })
            .on('data', (data) => {
              stdout += data.toString();
            })
            .stderr.on('data', (data) => {
              stderr += data.toString();
            });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect(cfg);
  });
}

function sshWriteFile(content, remotePath) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const cfg = getSSHConfig();

    conn
      .on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          const stream = sftp.createWriteStream(remotePath);
          stream.on('close', () => {
            conn.end();
            resolve();
          });
          stream.on('error', (e) => {
            conn.end();
            reject(e);
          });
          stream.write(content, 'utf8');
          stream.end();
        });
      })
      .on('error', reject)
      .connect(cfg);
  });
}

function sshRmdir(remotePath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const cfg = getSSHConfig();
    let timer;

    const cleanup = (err) => {
      clearTimeout(timer);
      conn.end();
      if (err) reject(err);
      else resolve();
    };

    conn
      .on('ready', () => {
        conn.exec(`rm -rf "${remotePath}"`, (err, stream) => {
          if (err) {
            return cleanup(err);
          }

          timer = setTimeout(() => {
            cleanup(new Error(`sshRmdir timed out after ${timeoutMs}ms`));
          }, timeoutMs);

          stream.on('close', () => cleanup());
          stream.on('error', (e) => cleanup(e));
        });
      })
      .on('error', (err) => cleanup(err))
      .connect(cfg);
  });
}

// ═══════════════════════════════════════════════════════════
// Servidor MCP
// ═══════════════════════════════════════════════════════════

const server = new Server(
  { name: 'supabase-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_sql',
      description:
        'Executa uma query SQL no Supabase via RPC. ' +
        'Requer a função execute_sql() no banco. ' +
        'Use SELECT, INSERT, UPDATE, DELETE, CREATE, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Query SQL a ser executada',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_tables',
      description: 'Lista todas as tabelas do schema public',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'describe_table',
      description: 'Descreve a estrutura de uma tabela',
      inputSchema: {
        type: 'object',
        properties: {
          table_name: { type: 'string', description: 'Nome da tabela' },
        },
        required: ['table_name'],
      },
    },
    {
      name: 'query_table',
      description: 'Executa SELECT * FROM tabela com limite de 100 linhas',
      inputSchema: {
        type: 'object',
        properties: {
          table_name: { type: 'string', description: 'Nome da tabela' },
          limit: {
            type: 'number',
            description: 'Limite de linhas (default: 100)',
            default: 100,
          },
        },
        required: ['table_name'],
      },
    },
    {
      name: 'list_edge_functions',
      description: 'Lista todas as Edge Functions deployadas na VPS',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'deploy_edge_function',
      description:
        'Deploya (cria ou atualiza) uma Edge Function na VPS. ' +
        'Salva o código em volumes/functions/<nome>/index.ts e reinicia o serviço.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Nome da função (ex: hello, create-mentor)',
          },
          code: {
            type: 'string',
            description: 'Código TypeScript da função (conteúdo do index.ts)',
          },
          restart: {
            type: 'boolean',
            description: 'Reiniciar o serviço functions após deploy (default: true)',
            default: true,
          },
        },
        required: ['name', 'code'],
      },
    },
    {
      name: 'delete_edge_function',
      description:
        'Remove uma Edge Function da VPS (apaga pasta em volumes/functions/<nome>).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Nome da função a remover',
          },
          restart: {
            type: 'boolean',
            description: 'Reiniciar o serviço functions após remoção (default: true)',
            default: true,
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_edge_function_logs',
      description: 'Obtém os logs do container de Edge Functions',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Número de linhas (default: 50)',
            default: 50,
          },
          follow: {
            type: 'boolean',
            description: 'Seguir logs em tempo real (default: false)',
            default: false,
          },
        },
      },
    },
    {
      name: 'restart_edge_functions',
      description: 'Reinicia o serviço de Edge Functions (container)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'invoke_edge_function',
      description:
        'Invoca uma Edge Function via HTTP POST. Útil para testar funções já deployadas.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Nome da função (ex: hello)',
          },
          body: {
            type: 'object',
            description: 'Payload JSON a enviar no body',
            default: {},
          },
          headers: {
            type: 'object',
            description: 'Headers adicionais',
            default: {},
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'deploy_local_edge_function',
      description:
        'Lê uma Edge Function do filesystem local e faz deploy na VPS. ' +
        'Útil para deployar código que foi criado/editado localmente no projeto.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Nome da função (ex: hello, create-mentor)',
          },
          local_path: {
            type: 'string',
            description: 'Caminho absoluto do arquivo index.ts local (ex: C:\\projeto\\supabase\\functions\\hello\\index.ts)',
          },
          restart: {
            type: 'boolean',
            description: 'Reiniciar o serviço functions após deploy (default: true)',
            default: true,
          },
        },
        required: ['name', 'local_path'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  function errorResponse(text) {
    return { content: [{ type: 'text', text }], isError: true };
  }

  function okResponse(text) {
    return { content: [{ type: 'text', text }] };
  }

  // ═══════════════════════════════════════════════════════════
  // execute_sql
  // ═══════════════════════════════════════════════════════════
  if (name === 'execute_sql') {
    const query = args.query?.trim();
    if (!query || typeof query !== 'string') {
      return errorResponse('❌ ERRO: query é obrigatória.');
    }

    try {
      const { data, error } = await supabase.rpc('execute_sql', { p_query: query });
      if (error) throw error;
      return okResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      return errorResponse(`❌ ERRO:\n${err.message}\n\nQuery: ${query}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // list_tables
  // ═══════════════════════════════════════════════════════════
  if (name === 'list_tables') {
    try {
      const { data, error } = await supabase.rpc('execute_sql', {
        p_query:
          "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      });
      if (error) throw error;
      return okResponse(JSON.stringify(data?.rows || data, null, 2));
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // describe_table
  // ═══════════════════════════════════════════════════════════
  if (name === 'describe_table') {
    const tableName = args.table_name;
    if (!tableName || typeof tableName !== 'string') {
      return errorResponse('❌ ERRO: table_name é obrigatório.');
    }

    const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
    if (safeTable !== tableName) {
      return errorResponse('❌ ERRO: table_name contém caracteres inválidos.');
    }

    try {
      const { data, error } = await supabase.rpc('execute_sql', {
        p_query: `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${safeTable}' ORDER BY ordinal_position`,
      });
      if (error) throw error;

      const columns = data?.rows || data;
      return okResponse(`Tabela: ${safeTable}\n\nColunas:\n${JSON.stringify(columns, null, 2)}`);
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // query_table
  // ═══════════════════════════════════════════════════════════
  if (name === 'query_table') {
    const limit = args.limit || 100;
    try {
      const { data, error } = await supabase.from(args.table_name).select('*').limit(limit);
      if (error) throw error;
      return okResponse(
        `SELECT * FROM ${args.table_name} LIMIT ${limit}\n\nResultado (${data.length} linhas):\n${JSON.stringify(data, null, 2)}`
      );
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // list_edge_functions
  // ═══════════════════════════════════════════════════════════
  if (name === 'list_edge_functions') {
    try {
      const functionsPath = `${DOCKER_PATH}/volumes/functions`;
      const { stdout, stderr, code } = await sshExec(
        `ls -1 "${functionsPath}" && echo "---DETAIL---" && find "${functionsPath}" -name "index.ts" | while read f; do echo "$f"; head -n 3 "$f"; echo "---"; done`
      );
      if (code !== 0) {
        return errorResponse(`❌ ERRO ao listar funções:\n${stderr || stdout}`);
      }
      return okResponse(`Edge Functions:\n\n${stdout}`);
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // deploy_edge_function
  // ═══════════════════════════════════════════════════════════
  if (name === 'deploy_edge_function') {
    const funcName = args.name;
    const code = args.code;
    const shouldRestart = args.restart !== false;

    if (!funcName || !code) {
      return errorResponse('❌ ERRO: name e code são obrigatórios.');
    }
    if (funcName === 'main') {
      return errorResponse('❌ ERRO: não é permitido sobrescrever a função main.');
    }

    try {
      const dirPath = `${DOCKER_PATH}/volumes/functions/${funcName}`;
      const filePath = `${dirPath}/index.ts`;

      await sshExec(`mkdir -p "${dirPath}"`);
      await sshWriteFile(code, filePath);

      let restartOutput = '';
      if (shouldRestart) {
        const { stdout, stderr, code: rc } = await sshExec(
          `cd "${DOCKER_PATH}" && docker compose restart functions --no-deps`
        );
        restartOutput = `\n\n🔄 Serviço reiniciado:\n${stdout}\n${stderr}`;
        if (rc !== 0) {
          restartOutput += '\n⚠️ Aviso: reinício pode ter falhado.';
        }
      }

      return okResponse(
        `✅ Função "${funcName}" deployada com sucesso.${restartOutput}`
      );
    } catch (err) {
      return errorResponse(`❌ ERRO no deploy: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // delete_edge_function
  // ═══════════════════════════════════════════════════════════
  if (name === 'delete_edge_function') {
    const funcName = args.name;
    const shouldRestart = args.restart !== false;

    if (!funcName) {
      return errorResponse('❌ ERRO: name é obrigatório.');
    }
    if (funcName === 'main') {
      return errorResponse('❌ ERRO: não é permitido remover a função main.');
    }

    try {
      const dirPath = `${DOCKER_PATH}/volumes/functions/${funcName}`;
      const { code: rmCode, stderr: rmStderr } = await sshExec(
        `rm -rf "${dirPath}"`,
        30000
      );
      if (rmCode !== 0) {
        return errorResponse(`❌ ERRO ao remover diretório: ${rmStderr || 'código ' + rmCode}`);
      }

      let restartOutput = '';
      if (shouldRestart) {
        const { stdout, stderr, code: rc } = await sshExec(
          `cd "${DOCKER_PATH}" && docker compose restart functions --no-deps`,
          60000
        );
        restartOutput = `\n\n🔄 Serviço reiniciado:\n${stdout}\n${stderr}`;
        if (rc !== 0) {
          restartOutput += '\n⚠️ Aviso: reinício pode ter falhado.';
        }
      }

      return okResponse(`🗑️ Função "${funcName}" removida.${restartOutput}`);
    } catch (err) {
      return errorResponse(`❌ ERRO na remoção: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // get_edge_function_logs
  // ═══════════════════════════════════════════════════════════
  if (name === 'get_edge_function_logs') {
    const lines = args.lines || 50;
    const follow = args.follow === true;

    try {
      const tailArg = follow ? '-f' : `--tail=${lines}`;
      const { stdout, stderr, code } = await sshExec(
        `cd "${DOCKER_PATH}" && docker compose logs ${tailArg} functions`,
        follow ? 15000 : 60000
      );
      if (code !== 0) {
        return errorResponse(`❌ ERRO:\n${stderr || stdout}`);
      }
      return okResponse(`Logs do serviço functions:\n\n${stdout}\n${stderr}`);
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // restart_edge_functions
  // ═══════════════════════════════════════════════════════════
  if (name === 'restart_edge_functions') {
    try {
      const { stdout, stderr, code } = await sshExec(
        `cd "${DOCKER_PATH}" && docker compose restart functions --no-deps`
      );
      if (code !== 0) {
        return errorResponse(`❌ ERRO:\n${stderr || stdout}`);
      }
      return okResponse(`🔄 Serviço functions reiniciado:\n${stdout}\n${stderr}`);
    } catch (err) {
      return errorResponse(`❌ ERRO: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // invoke_edge_function
  // ═══════════════════════════════════════════════════════════
  if (name === 'invoke_edge_function') {
    const funcName = args.name;
    const body = args.body || {};
    const headers = args.headers || {};

    try {
      const url = `${SUPABASE_URL}/functions/v1/${funcName}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      return okResponse(
        `Status: ${response.status} ${response.statusText}\nURL: ${url}\n\nResposta:\n${responseText}`
      );
    } catch (err) {
      return errorResponse(`❌ ERRO na invocação: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // deploy_local_edge_function
  // ═══════════════════════════════════════════════════════════
  if (name === 'deploy_local_edge_function') {
    const funcName = args.name;
    const localPath = args.local_path;
    const shouldRestart = args.restart !== false;

    if (!funcName || !localPath) {
      return errorResponse('❌ ERRO: name e local_path são obrigatórios.');
    }
    if (funcName === 'main') {
      return errorResponse('❌ ERRO: não é permitido sobrescrever a função main.');
    }

    let code;
    try {
      code = readFileSync(localPath, 'utf8');
    } catch (err) {
      return errorResponse(`❌ ERRO ao ler arquivo local: ${err.message}`);
    }

    try {
      const dirPath = `${DOCKER_PATH}/volumes/functions/${funcName}`;
      const filePath = `${dirPath}/index.ts`;

      await sshExec(`mkdir -p "${dirPath}"`);
      await sshWriteFile(code, filePath);

      let restartOutput = '';
      if (shouldRestart) {
        const { stdout, stderr, code: rc } = await sshExec(
          `cd "${DOCKER_PATH}" && docker compose restart functions --no-deps`
        );
        restartOutput = `\n\n🔄 Serviço reiniciado:\n${stdout}\n${stderr}`;
        if (rc !== 0) {
          restartOutput += '\n⚠️ Aviso: reinício pode ter falhado.';
        }
      }

      return okResponse(
        `✅ Função "${funcName}" deployada a partir de "${localPath}".${restartOutput}`
      );
    } catch (err) {
      return errorResponse(`❌ ERRO no deploy: ${err.message}`);
    }
  }

  return errorResponse(`❌ Ferramenta desconhecida: ${name}`);
});

// ═══════════════════════════════════════════════════════════
// Inicia
// ═══════════════════════════════════════════════════════════
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 MCP Server rodando (stdio)');
  console.error(`   Instância: ${INSTANCE_NAME} (${SUPABASE_URL})`);
  console.error('   Ferramentas DB: execute_sql, list_tables, describe_table, query_table');
  console.error(
    '   Ferramentas Edge: list_edge_functions, deploy_edge_function, deploy_local_edge_function, delete_edge_function, get_edge_function_logs, restart_edge_functions, invoke_edge_function'
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
