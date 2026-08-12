import type {
  ArtifactRef,
  Event,
  Product,
  Resource,
  Task,
  Workspace,
} from '../../packages/core/src/index.js';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type _ProductIsExported = Assert<Equal<Product['uuid'], string>>;
type _WorkspaceIsExported = Assert<Equal<Workspace['product_id'], string>>;
type _ResourceIsExported = Assert<Equal<Resource['workspace_id'], string>>;
type _TaskIsExported = Assert<Equal<Task['initiative_id'], string>>;
type _ArtifactRefIsExported = Assert<Equal<ArtifactRef['path_or_uri'], string>>;
type _EventIsExported = Assert<Equal<Event['event_sequence'], number>>;
