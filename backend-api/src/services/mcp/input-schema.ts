import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

// Keep legacy schemas on Draft-07; explicitly declared modern schemas need their
// own compiler because keywords such as prefixItems have different semantics.
export function compileMcpInputSchema(schema: any): ValidateFunction {
  const dialect = schema?.$schema;
  let Compiler = Ajv;
  let canonical: string | undefined;
  if (dialect !== undefined) {
    if (typeof dialect !== 'string') throw new Error('mcp_invalid_tool_schema');
    if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(dialect)) {
      Compiler = Ajv2020;
      canonical = 'https://json-schema.org/draft/2020-12/schema';
    } else if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(dialect)) {
      Compiler = Ajv2019;
      canonical = 'https://json-schema.org/draft/2019-09/schema';
    } else if (/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(dialect)) {
      canonical = 'http://json-schema.org/draft-07/schema#';
    } else {
      throw new Error('mcp_unsupported_schema_dialect');
    }
  }
  try {
    return new Compiler({ strict: false, allErrors: false, validateFormats: false }).compile(
      canonical ? { ...schema, $schema: canonical } : schema,
    );
  } catch (cause) {
    throw new Error('mcp_invalid_tool_schema', { cause });
  }
}
