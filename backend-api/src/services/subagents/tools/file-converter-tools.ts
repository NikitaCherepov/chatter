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
    return error('Десктоп-клиент не подключён. Конвертация выполняется локально на компьютере пользователя.');
  }
  return null;
}

const listDirectory: SubagentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'Прочитать содержимое директории на компьютере пользователя. Инструмент работает только на чтение.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Абсолютный путь к директории.',
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
    if (!directoryPath) return error('path обязателен');

    const settings = getPcCommandsSettings(ctx.userId);
    if (!settings.fs_scan_enabled) {
      return error('Чтение директорий отключено в настройках «Управление ПК».');
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
      description: 'Конвертировать локальный видеофайл через ffmpeg в desktop-приложении. Произвольные ffmpeg-аргументы и перезапись файлов не поддерживаются.',
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: 'Абсолютный путь к исходному видеофайлу.',
          },
          output_format: {
            type: 'string',
            enum: [...VIDEO_FORMATS],
            description: 'Формат результата.',
          },
          output_path: {
            type: 'string',
            description: 'Необязательный абсолютный путь результата: полный путь файла или существующая директория. По умолчанию результат создаётся рядом с исходным с суффиксом _converted.',
          },
          quality: {
            type: 'string',
            enum: [...VIDEO_QUALITIES],
            description: 'Профиль качества: high, balanced (по умолчанию) или small.',
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

    if (!sourcePath) return error('source_path обязателен');
    if (!(VIDEO_FORMATS as readonly string[]).includes(outputFormat)) {
      return error(`Неподдерживаемый output_format. Доступно: ${VIDEO_FORMATS.join(', ')}`);
    }
    if (!(VIDEO_QUALITIES as readonly string[]).includes(quality)) {
      return error(`Неподдерживаемый quality. Доступно: ${VIDEO_QUALITIES.join(', ')}`);
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
