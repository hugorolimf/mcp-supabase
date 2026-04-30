# MCP Server — Supabase SQL Executor

Servidor MCP genérico para executar SQL em qualquer instância Supabase (cloud ou self-hosted).

## Pré-requisitos no banco

Crie a função RPC `execute_sql` no seu Supabase:

```sql
CREATE OR REPLACE FUNCTION execute_sql(p_query TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  rows_json JSONB := '[]'::JSONB;
BEGIN
  IF trim(upper(left(p_query, 6))) = 'SELECT' THEN
    FOR rec IN EXECUTE p_query LOOP
      rows_json := rows_json || to_jsonb(rec);
    END LOOP;
    RETURN jsonb_build_object(
      'command', 'SELECT',
      'rowCount', jsonb_array_length(rows_json),
      'rows', rows_json
    );
  END IF;
  EXECUTE p_query;
  RETURN jsonb_build_object(
    'command', trim(upper(left(p_query, 6))),
    'success', true,
    'message', 'Query executada com sucesso'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'command', trim(upper(left(p_query, 6))),
    'success', false,
    'error', SQLERRM,
    'detail', SQLSTATE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION execute_sql(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_sql(TEXT) TO anon;
```

## Setup

```bash
cd mcp-server
copy .env.example .env
# Edite .env com seus dados
npm install
npm start
```

## Variáveis de ambiente (.env)

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_KEY=sua-service-role-key
```

> ⚠️ Use a **Service Role Key** (nunca a Anon Key no frontend). Encontre em: Supabase Dashboard > Project Settings > API > service_role.

## Ferramentas disponíveis

| Ferramenta | Descrição |
|------------|-----------|
| `execute_sql` | Executa qualquer query SQL via RPC |
| `list_tables` | Lista tabelas do schema `public` |
| `describe_table` | Retorna colunas e tipos de uma tabela |
| `query_table` | SELECT * com limite de 100 linhas |

## Conectar no Kimi / Claude / Cursor

### Kimi CLI

Edite `%APPDATA%\Kimi\mcp.json` (Windows) ou `~/.kimi/mcp.json` (Mac/Linux):

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": [
        "C:\\caminho\\para\\mcp-server\\index.js"
      ]
    }
  }
}
```

### Claude Desktop

Edite `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["/caminho/para/mcp-server/index.js"]
    }
  }
}
```

## Segurança

- O `.env` está no `.gitignore` — credenciais não são commitadas
- O servidor roda **localmente** na sua máquina
- Use a `SERVICE_ROLE_KEY` com cautela — ela bypassa RLS
