type MonacoExtraLibDefaults = {
  addExtraLib: (content: string, filePath?: string) => unknown;
};

type MonacoWithTypeScriptDefaults = {
  languages: {
    typescript: {
      typescriptDefaults: MonacoExtraLibDefaults;
      javascriptDefaults: MonacoExtraLibDefaults;
    };
  };
};

let reactTypeLibrariesRegistered = false;

const REACT_TYPE_LIBRARY = `
declare namespace React {
  type Key = string | number | bigint;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Dispatch<A> = (value: A) => void;
  type RefCallback<T> = (instance: T | null) => void;

  interface RefObject<T> {
    current: T | null;
  }

  type Ref<T> = RefCallback<T> | RefObject<T> | null;
  type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | ReactNode[];

  interface ReactElement<P = unknown, T = unknown> {
    type: T;
    props: P;
    key: Key | null;
  }

  type JSXElementConstructor<P> =
    | ((props: P) => ReactNode)
    | (new (props: P) => Component<P, unknown>);

  type ElementType<P = unknown> = keyof JSX.IntrinsicElements | JSXElementConstructor<P>;
  type ComponentType<P = unknown> = FunctionComponent<P> | ComponentClass<P>;

  interface Component<P = unknown, S = unknown> {
    props: P;
    state: S;
    setState(state: Partial<S> | S | null): void;
    forceUpdate(): void;
    render(): ReactNode;
  }

  interface ComponentClass<P = unknown> {
    new (props: P): Component<P, unknown>;
  }

  interface FunctionComponent<P = unknown> {
    (props: P): ReactNode;
    displayName?: string;
  }

  type FC<P = unknown> = FunctionComponent<P>;
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  type ComponentProps<T extends keyof JSX.IntrinsicElements | JSXElementConstructor<unknown>> =
    T extends JSXElementConstructor<infer P> ? P :
    T extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[T] :
    unknown;
  type CSSProperties = Record<string, string | number | undefined>;

  const Fragment: unique symbol;
  const StrictMode: FC<PropsWithChildren>;

  function createElement(type: ElementType | string, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement;
  function cloneElement<P>(element: ReactElement<P>, props?: Partial<P> | null, ...children: ReactNode[]): ReactElement<P>;
  function isValidElement(value: unknown): value is ReactElement;
  function memo<T extends ComponentType>(component: T): T;
  function forwardRef<T, P = unknown>(render: (props: P, ref: Ref<T>) => ReactNode): FunctionComponent<P & { ref?: Ref<T> }>;
  function lazy<T extends ComponentType>(loader: () => Promise<{ default: T }>): T;

  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useReducer<R extends (state: never, action: never) => never>(reducer: R, initialState: Parameters<R>[0]): [Parameters<R>[0], Dispatch<Parameters<R>[1]>];
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  function useMemo<T>(factory: () => T, deps: readonly unknown[] | undefined): T;
  function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[] | undefined): T;
  function useRef<T>(initialValue: T): { current: T };
  function useRef<T>(initialValue: T | null): RefObject<T>;
  function useContext<T>(context: Context<T>): T;
  function useId(): string;

  interface Context<T> {
    Provider: ComponentType<{ value: T; children?: ReactNode }>;
    Consumer: ComponentType<{ children: (value: T) => ReactNode }>;
  }

  function createContext<T>(defaultValue: T): Context<T>;

  namespace JSX {
    type Element = ReactElement;
    interface ElementClass {
      render(): ReactNode;
    }
    interface ElementAttributesProperty {
      props: unknown;
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
    interface IntrinsicAttributes {
      key?: Key | null;
    }
    interface IntrinsicClassAttributes<T> {
      ref?: Ref<T>;
    }
    interface IntrinsicElements {
      [elemName: string]: unknown;
    }
  }
}

declare namespace JSX {
  type Element = React.ReactElement;
  interface ElementClass extends React.JSX.ElementClass {}
  interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
  interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  interface IntrinsicElements extends React.JSX.IntrinsicElements {}
}

declare module 'react' {
  export = React;
}

declare module 'react/jsx-runtime' {
  export namespace JSX {
    type Element = React.JSX.Element;
    interface ElementClass extends React.JSX.ElementClass {}
    interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }

  export const Fragment: typeof React.Fragment;
  export function jsx(type: React.ElementType | string, props: unknown, key?: React.Key): React.ReactElement;
  export function jsxs(type: React.ElementType | string, props: unknown, key?: React.Key): React.ReactElement;
}

declare module 'react/jsx-dev-runtime' {
  export { Fragment, jsx, jsxs } from 'react/jsx-runtime';
  export function jsxDEV(type: React.ElementType | string, props: unknown, key?: React.Key, isStaticChildren?: boolean, source?: unknown, self?: unknown): React.ReactElement;
}
`;

export function registerReactTypeLibraries(monaco: unknown) {
  if (reactTypeLibrariesRegistered) return;
  reactTypeLibrariesRegistered = true;

  const monacoWithDefaults = monaco as MonacoWithTypeScriptDefaults;
  const filePath = 'file:///node_modules/@types/tmcode-react/index.d.ts';
  monacoWithDefaults.languages.typescript.typescriptDefaults.addExtraLib(REACT_TYPE_LIBRARY, filePath);
  monacoWithDefaults.languages.typescript.javascriptDefaults.addExtraLib(REACT_TYPE_LIBRARY, filePath);
}
