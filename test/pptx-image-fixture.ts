import { ZipFile } from "yazl";
import { fromBufferPromise } from "yauzl";

export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const DECORATIVE =
  "http://schemas.microsoft.com/office/drawing/2017/decorative";
export const DECORATIVE_EXTENSION = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}";
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function pictureXml(
  options: {
    id?: number;
    description?: string;
    title?: string;
    decorative?: boolean;
    metadata?: string;
    hidden?: boolean;
    measured?: boolean;
    linked?: boolean;
  } = {}
): string {
  const { id = 3, description = "", title = "", metadata = "" } = options;
  const extension =
    options.decorative === undefined
      ? ""
      : `<a:extLst><a:ext uri="${DECORATIVE_EXTENSION}"><adec:decorative xmlns:adec="${DECORATIVE}" val="${options.decorative ? 1 : 0}"/></a:ext></a:extLst>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${xml(description)}" title="${xml(title)}"${options.hidden ? ' hidden="1"' : ""}>${metadata}${extension}</p:cNvPr><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip ${options.linked ? 'r:link="rLinked"' : 'r:embed="rImage"'}/></p:blipFill><p:spPr>${options.measured === false ? "" : '<a:xfrm><a:off x="3000000" y="3000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm>'}</p:spPr></p:pic>`;
}

export async function zipParts(
  parts: [string, Buffer | string][]
): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, value] of parts) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  return done;
}

export async function imageFixture(
  options: {
    picture?: string;
    timing?: string;
    extraRelationships?: string;
    extraParts?: [string, Buffer | string][];
  } = {}
): Promise<Buffer> {
  return zipParts([
    [
      "[Content_Types].xml",
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rMain" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ],
    [
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rSlide"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rSlide" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ],
    [
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="5000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Course image</a:t></a:r></a:p></p:txBody></p:sp>${options.picture ?? pictureXml()}</p:spTree></p:cSld>${options.timing ?? ""}</p:sld>`,
    ],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rImage" Type="${R}/image" Target="../media/image1.png"/>${options.extraRelationships ?? ""}</Relationships>`,
    ],
    ["ppt/media/image1.png", Buffer.from([1, 2, 3, 4, 5])],
    ...(options.extraParts ?? []),
  ]);
}

export async function unzipParts(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(buffer);
  const result = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  zip.close();
  return result;
}
