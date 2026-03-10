declare module 'html2canvas' {
  interface Options {
    width?: number;
    height?: number;
    useCORS?: boolean;
    allowTaint?: boolean;
    backgroundColor?: string;
    scale?: number;
    logging?: boolean;
  }
  function html2canvas(element: HTMLElement, options?: Options): Promise<HTMLCanvasElement>;
  export default html2canvas;
}
