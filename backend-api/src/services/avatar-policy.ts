export function avatarControlAllowed(flags: { hide_pixel_avatar?: boolean; disable_avatar_control?: boolean } | null | undefined, imageUrl: string | null | undefined): boolean {
  return !flags?.hide_pixel_avatar && !flags?.disable_avatar_control && !imageUrl;
}
export function withoutAvatarTools(tools: readonly any[]): any[] {
  return tools.filter(tool => !['get_avatar_state', 'set_display_state'].includes(tool?.function?.name)).map(tool => {
    if (tool?.function?.name !== 'create_pixel_image') return tool;
    const properties = { ...(tool.function.parameters?.properties || {}) };
    delete properties.set_as_avatar;
    const parameters = { ...tool.function.parameters, properties };
    if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter((key: string) => key !== 'set_as_avatar');
    return { ...tool, function: { ...tool.function, parameters } };
  });
}
