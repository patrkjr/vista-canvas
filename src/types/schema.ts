import { z } from 'zod';

export const SemanticZoomLevelSchema = z.enum(['macro', 'meso', 'micro']);

export const CanvasPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const CanvasNodeFrameSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export const CanvasNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['screen', 'fixture', 'module']),
    title: z.string().min(1),
    route: z.string().min(1),
    mfe: z.string().min(1),
    position: CanvasPointSchema,
    dataScreen: z.string().min(1).optional(),
    previewPath: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
    fixture: z.string().min(1).optional(),
    frame: CanvasNodeFrameSchema.optional(),
  })
  .superRefine((node, ctx) => {
    if (node.kind !== 'fixture') return;
    if (!node.parentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fixture nodes require parentId',
        path: ['parentId'],
      });
    }
    if (!node.fixture) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fixture nodes require fixture',
        path: ['fixture'],
      });
    }
  });

export const CanvasEdgeKindSchema = z.enum(['flow', 'nav']);

export const CanvasEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: CanvasEdgeKindSchema.optional(),
});

export const CanvasViewStateSchema = z.object({
  pan: CanvasPointSchema,
  zoom: z.number().positive(),
  selectedNodeId: z.string().nullable(),
  /** Optional for older documents; normalize coerces missing → null. */
  focusedNodeId: z.string().nullable().optional(),
  semanticZoomLevel: SemanticZoomLevelSchema,
});

export const DesignCanvasDocumentSchema = z.object({
  version: z.number().int().positive(),
  target: z.string().min(1),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  view: CanvasViewStateSchema,
});

export type DesignCanvasDocumentParsed = z.infer<typeof DesignCanvasDocumentSchema>;
