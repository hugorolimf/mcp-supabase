#!/usr/bin/env node

/**
 * MCP Server — Supabase SQL Executor
 *
 * Servidor MCP genérico que conecta a qualquer Supabase (cloud ou self-hosted)
 * via PostgREST usando SERVICE_ROLE_KEY para executar SQL arbitrário via RPC.
 *
 * Requisitos no banco:
 *   CREATE OR REPLACE FUNCTION execute_sql(p_query TEXT)
 *   RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$ ... $$;
 *
 * Uso:
 *   1. npm install
 *   2. Configure .env (SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *   3. npm start
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

// ───────────────────────────────────────────────────────────
// Configuração (apenas via .env — sem hardcode)
// ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '❌ ERRO: SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.\n' +
    '   Configure o arquivo .env'
  );
  process.exit(1);
}

// ───────────────────────────────────────────────────────────
// Cliente Supabase com Service Role (acesso total)
// ───────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ───────────────────────────────────────────────────────────
// Servidor MCP
// ───────────────────────────────────────────────────────────
const server = new Server(
  { name: 'supabase-mcp', version: '1.0.0' },
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
          limit: { type: 'number', description: 'Limite de linhas (default: 100)', default: 100 },
        },
        required: ['table_name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── execute_sql ──
  if (name === 'execute_sql') {
    const query = args.query;
    if (!query || typeof query !== 'string') {
      return {
        content: [{ type: 'text', text: '❌ ERRO: query é obrigatória.' }],
        isError: true,
      };
    }

    try {
      const { data, error } = await supabase.rpc('execute_sql', { p_query: query });
      if (error) throw error;

      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ ERRO:\n${err.message}\n\nQuery: ${query}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── list_tables ──
  if (name === 'list_tables') {
    const { data, error } = await supabase.rpc('execute_sql', {
      p_query: "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    });

    if (error) {
      return {
        content: [{ type: 'text', text: `❌ ERRO: ${error.message}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data?.rows || data, null, 2) }],
    };
  }

  // ── describe_table ──
  if (name === 'describe_table') {
    const { data, error } = await supabase.rpc('execute_sql', {
      p_query: `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${args.table_name}' ORDER BY ordinal_position`
    });

    if (error) {
      return {
        content: [{ type: 'text', text: `❌ ERRO: ${error.message}` }],
        isError: true,
      };
    }

    const columns = data?.rows || data;

    return {
      content: [
        {
          type: 'text',
          text: `Tabela: ${args.table_name}\n\nColunas:\n${JSON.stringify(columns, null, 2)}`,
        },
      ],
    };
  }

  // ── query_table ──
  if (name === 'query_table') {
    const limit = args.limit || 100;
    const { data, error } = await supabase
      .from(args.table_name)
      .select('*')
      .limit(limit);

    if (error) {
      return {
        content: [{ type: 'text', text: `❌ ERRO: ${error.message}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `SELECT * FROM ${args.table_name} LIMIT ${limit}\n\nResultado (${data.length} linhas):\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `❌ Ferramenta desconhecida: ${name}` }],
    isError: true,
  };
});

// ───────────────────────────────────────────────────────────
// Inicia
// ───────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 MCP Server rodando (stdio)');
  console.error('   Ferramentas: execute_sql, list_tables, describe_table, query_table');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
