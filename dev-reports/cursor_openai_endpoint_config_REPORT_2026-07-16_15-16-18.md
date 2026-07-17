# Relatório: configuração Cursor → endpoint OpenAI-compatível

**Data:** 2026-07-16 15:16:18  
**Tipo:** orientação (sem alteração de código)

## Resumo

Documentada a forma de apontar o Cursor IDE para o gateway do ia-stack (`http://127.0.0.1:11434/v1`) via BYOK / Override OpenAI Base URL, incluindo riscos conhecidos do Cursor com esse recurso.

## Arquivos alterados

Nenhum (apenas este relatório).

## Testes

Nenhum.

## Observações

- O repo documenta Copilot/opencode/Claude Code em `docs/connecting-tools.md`, mas **não** tem seção Cursor.
- Cursor BYOK com base URL customizada tem bugs conhecidos (payload Responses em `/chat/completions`; override global).
- O gateway já expõe `/v1/chat/completions`, `/v1/responses` e `/v1/models`.

## Branch / merge

N/A — sem mudanças de código.
