// Web: baixa o arquivo pelo navegador.
export async function shareGpx(fileName: string, gpx: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
