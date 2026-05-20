declare module 'fluent-ffmpeg' {
  interface FfmpegCommand {
    outputOptions(options: string | string[]): this;
    save(outputPath: string): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  interface FfmpegStatic {
    (input?: string): FfmpegCommand;
    setFfmpegPath(path: string): void;
  }

  const ffmpeg: FfmpegStatic;
  export default ffmpeg;
}

declare module 'ffmpeg-static' {
  const path: string | null;
  export default path;
}
