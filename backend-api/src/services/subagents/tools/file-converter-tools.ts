import { isDesktopOnline, sendIpcToDesktop } from '../../../ws-clients.js';
import { getPcCommandsSettings } from '../../pc-commands.js';
import type { SubagentContext, SubagentTool } from '../types.js';

const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'mov'] as const;
const VIDEO_QUALITIES = ['high', 'balanced', 'small'] as const;
const CONVERSION_TIMEOUT_MS = 30 * 60_000;

function error(message: string): string {
  return JSON.stringify({ status: 'error', message });
}

function requireDesktop(ctx: SubagentContext): string | null {
  if (!ctx.isDesktop || !isDesktopOnline(ctx.userId)) {
    return error('The desktop client is not connected. Conversion runs locally on the user\'s computer.');
  }
  return null;
}

const listDirectory: SubagentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory on the user\'s computer. This tool is read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory.',
          },
        },
        required: ['path'],
      },
    },
  },
  handler: async (args, ctx) => {
    const desktopError = requireDesktop(ctx);
    if (desktopError) return desktopError;

    const directoryPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!directoryPath) return error('path is required');

    const settings = getPcCommandsSettings(ctx.userId);
    if (!settings.fs_scan_enabled) {
      return error('Directory scanning is disabled in the PC Control settings.');
    }

    try {
      const entries = await sendIpcToDesktop(
        ctx.userId,
        'read_directory',
        { target_path: directoryPath },
        30_000,
        ctx.signal,
      );
      return JSON.stringify({ status: 'success', path: directoryPath, entries });
    } catch (err: any) {
      return error(err?.message || String(err));
    }
  },
};

const convertVideo: SubagentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'convert_video',
      description: 'Convert a local video with ffmpeg in the desktop application. Arbitrary ffmpeg arguments and overwriting existing files are not supported.',
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: 'Absolute path to the source video file.',
          },
          output_format: {
            type: 'string',
            enum: [...VIDEO_FORMATS],
            description: 'Output video format.',
          },
          output_path: {
            type: 'string',
            description: 'Optional absolute output path: either a complete file path or an existing directory. By default, the result is created next to the source with the _converted suffix.',
          },
          quality: {
            type: 'string',
            enum: [...VIDEO_QUALITIES],
            description: 'Quality profile: high, balanced (default), or small.',
          },
        },
        required: ['source_path', 'output_format'],
      },
    },
  },
  handler: async (args, ctx) => {
    const desktopError = requireDesktop(ctx);
    if (desktopError) return desktopError;

    const sourcePath = typeof args.source_path === 'string' ? args.source_path.trim() : '';
    const outputPath = typeof args.output_path === 'string' ? args.output_path.trim() : undefined;
    const outputFormat = typeof args.output_format === 'string' ? args.output_format.toLowerCase() : '';
    const quality = typeof args.quality === 'string' ? args.quality.toLowerCase() : 'balanced';

    if (!sourcePath) return error('source_path is required');
    if (!(VIDEO_FORMATS as readonly string[]).includes(outputFormat)) {
      return error(`Unsupported output_format. Available values: ${VIDEO_FORMATS.join(', ')}`);
    }
    if (!(VIDEO_QUALITIES as readonly string[]).includes(quality)) {
      return error(`Unsupported quality. Available values: ${VIDEO_QUALITIES.join(', ')}`);
    }

    try {
      const result = await sendIpcToDesktop(
        ctx.userId,
        'convert_video',
        {
          source_path: sourcePath,
          output_path: outputPath,
          output_format: outputFormat,
          quality,
        },
        CONVERSION_TIMEOUT_MS,
        ctx.signal,
      );
      return JSON.stringify({ status: 'success', ...result });
    } catch (err: any) {
      return error(err?.message || String(err));
    }
  },
};

export const fileConverterTools: SubagentTool[] = [listDirectory, convertVideo];
