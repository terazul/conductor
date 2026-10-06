/**
 * A rendered markdown file, printed on its own — which is how it becomes a PDF.  TRACK C.
 * (Amendment 32)
 *
 * The browser's print dialog already saves a PDF, so exporting one is a matter of
 * what gets printed. The screen is a shell of panes that scroll, which prints as one
 * clipped page of chrome. Instead the rendered file is copied into a sheet at the end
 * of <body>, and files.css's print rules hide everything else. The copy is of the
 * elements already on screen — sanitised by the daemon, links and images already
 * pointed where the file meant them — so nothing new is rendered, and there is still
 * one sanitizer to audit.
 *
 * The sheet is marked light (tokens.css): paper is light whichever theme you read in.
 */

/** The name the PDF is offered under: the file's, without the markdown extension. */
export function pdfTitle(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.(md|markdown|mdx)$/i, '') || name;
}

export async function printRendered(from: HTMLElement, path: string): Promise<void> {
  const sheet = document.createElement('div');
  sheet.className = 'c5-print';
  sheet.dataset['theme'] = 'light';
  sheet.append(from.cloneNode(true));
  document.body.append(sheet);

  // An image that hasn't decoded yet prints as a gap.
  await Promise.all(
    [...sheet.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );

  // Most browsers offer the page title as the PDF's file name.
  const title = document.title;
  document.title = pdfTitle(path);
  const done = (): void => {
    window.removeEventListener('afterprint', done);
    sheet.remove();
    document.title = title;
  };
  window.addEventListener('afterprint', done);
  window.print();
}
