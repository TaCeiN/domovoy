/** Типы для osm-pbf.mjs: сам читатель остаётся JavaScript, как и в инструменте */
export function scan(
  path: string,
  handlers: {
    onNode?: (id: number, lat: number, lon: number, tags: Record<string, string> | null) => void;
    onWay?: (id: number, tags: Record<string, string>, refs: number[]) => void;
    onRelation?: (id: number, tags: Record<string, string>, ways: number[]) => void;
  },
): Promise<void>;
