/** Public event categories only: never accept content, arguments, or results. */
export type ActivityPhase = 'working' | 'thinking' | 'responding' | 'tool' | 'idle';
export type ActivityDetail = 'processing' | 'thinking' | 'responding' | 'reading_files' |
  'editing_files' | 'running_command' | 'using_tool' | 'multiple_tools' | 'settled';

function toolDetail(name: string): ActivityDetail {
  switch (name) {
    case 'read': return 'reading_files';
    case 'edit':
    case 'write': return 'editing_files';
    case 'bash':
    case 'powershell': return 'running_command';
    default: return 'using_tool';
  }
}

/** Stores only opaque active tool IDs, public categories, and the last emitted state. */
export function createActivityTracker(record: (phase: ActivityPhase, detail: ActivityDetail) => void) {
  const tools = new Map<string, ActivityDetail>();
  let lastPhase: ActivityPhase | undefined;
  let lastDetail: ActivityDetail | undefined;
  function emit(phase: ActivityPhase, detail: ActivityDetail): void {
    if (lastPhase === phase && lastDetail === detail) return;
    lastPhase = phase;
    lastDetail = detail;
    record(phase, detail);
  }
  function emitTools(): void {
    const detail = tools.size > 1 ? 'multiple_tools' : tools.values().next().value;
    if (detail) emit('tool', detail);
  }
  return {
    start(): void {
      tools.clear();
      emit('working', 'processing');
    },
    settled(): void {
      tools.clear();
      emit('idle', 'settled');
    },
    message(type: string): void {
      if (tools.size) return;
      switch (type) {
        case 'thinking_start':
        case 'thinking_delta': emit('thinking', 'thinking'); break;
        case 'thinking_end': emit('working', 'processing'); break;
        case 'text_start':
        case 'text_delta': emit('responding', 'responding'); break;
      }
    },
    toolStart(id: string, name: string): void {
      tools.set(id, toolDetail(name));
      emitTools();
    },
    toolEnd(id: string): void {
      if (!tools.delete(id)) return;
      if (tools.size) emitTools();
      else emit('working', 'processing');
    },
    reset(): void {
      tools.clear();
      lastPhase = undefined;
      lastDetail = undefined;
    },
  };
}
