const text = { type: 'string', minLength: 1, maxLength: 4000 };
const strings = { type: 'array', items: text, maxItems: 12 };
function object(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
export const analysisSchema = object({ summary: text, prerequisites: strings, focus: strings });
export const planSchema = object({
  title: { type: 'string', minLength: 1, maxLength: 160 },
  description: { type: 'string', minLength: 1, maxLength: 1200 },
  objectives: { ...strings, minItems: 1 },
  prerequisites: strings,
  chapters: {
    type: 'array',
    minItems: 1,
    maxItems: 4,
    items: object({
      title: { type: 'string', minLength: 1, maxLength: 160 },
      objective: { type: 'string', minLength: 1, maxLength: 600 },
      lessons: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: object({
          title: { type: 'string', minLength: 1, maxLength: 160 },
          objective: { type: 'string', minLength: 1, maxLength: 600 },
          minutes: { type: 'integer', minimum: 5, maximum: 25 },
          knowledgePoints: { ...strings, minItems: 1 },
          techniques: { ...strings, minItems: 1 },
          sources: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: object({
              title: { type: 'string', minLength: 1, maxLength: 300 },
              url: { type: 'string', minLength: 1, maxLength: 2000 },
            }),
          },
        }),
      },
    }),
  },
});
export const lessonSchema = object({
  source: { type: 'string', minLength: 80, maxLength: 24000 },
  exercises: {
    type: 'array',
    minItems: 2,
    maxItems: 5,
    items: object({
      question: text,
      options: { type: 'array', maxItems: 6, items: text },
      answer: text,
      explanation: text,
      skill: text,
    }),
  },
});
export const auditSchema = object({
  approved: { type: 'boolean' },
  summary: text,
  issues: {
    type: 'array',
    maxItems: 8,
    items: object({ lessonIndex: { type: 'integer', minimum: 0, maximum: 7 }, problem: text }),
  },
});
export const tutorSchema = object({ answer: { type: 'string', minLength: 1, maxLength: 12000 } });
export const gradeSchema = object({
  feedback: text,
  items: {
    type: 'array',
    minItems: 1,
    maxItems: 5,
    items: object({ exerciseId: text, correct: { type: 'boolean' }, feedback: text }),
  },
  nextSteps: strings,
});
export const reviewSchema = object({
  title: text,
  summary: text,
  strengths: strings,
  gaps: strings,
  nextSteps: strings,
});

/** Validate again on the server: a CLI's schema promise is not a storage boundary. */
export function assertSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = 'result',
): void {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${path} 需要为对象。`);
    const data = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of schema.required as string[])
      if (!Object.hasOwn(data, key)) throw new Error(`${path}.${key} 缺失。`);
    if (
      schema.additionalProperties === false &&
      Object.keys(data).some((k) => !Object.hasOwn(properties, k))
    )
      throw new Error(`${path} 包含未定义字段。`);
    for (const key of Object.keys(properties))
      if (Object.hasOwn(data, key)) assertSchema(data[key], properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < Number(schema.minItems ?? 0) ||
      value.length > Number(schema.maxItems ?? 100)
    )
      throw new Error(`${path} 数量无效。`);
    value.forEach((item, i) =>
      assertSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`),
    );
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.trim().length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? 100000)
    )
      throw new Error(`${path} 文本无效。`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} 需要为布尔值。`);
  } else if (schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < Number(schema.minimum ?? -Infinity) ||
      value > Number(schema.maximum ?? Infinity)
    )
      throw new Error(`${path} 数值无效。`);
  }
}
