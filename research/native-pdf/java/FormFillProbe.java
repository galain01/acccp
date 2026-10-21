/* Local regression tool: use PDFBox's real form editing path, then reopen saved appearances. */
import java.awt.Shape;
import java.awt.geom.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;
import org.apache.pdfbox.util.Version;

public final class FormFillProbe {
    static String hash(byte[] data) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    }
    static Map<String,Object> map(Object... pairs) {
        Map<String,Object> m=new LinkedHashMap<>();
        for(int i=0;i<pairs.length;i+=2)m.put((String)pairs[i],pairs[i+1]);
        return m;
    }
    static String json(Object x) {
        if(x==null)return "null";
        if(x instanceof String) {
            StringBuilder s=new StringBuilder("\"");
            for(char c:((String)x).toCharArray()) {
                if(c=='"'||c=='\\')s.append('\\').append(c);
                else if(c<32||c>126)s.append(String.format("\\u%04x",(int)c));
                else s.append(c);
            }
            return s.append('"').toString();
        }
        if(x instanceof Map) {
            List<String> parts=new ArrayList<>();
            ((Map<?,?>)x).forEach((k,v)->parts.add(json(k.toString())+":"+json(v)));
            return "{"+String.join(",",parts)+"}";
        }
        if(x instanceof Iterable) {
            List<String> parts=new ArrayList<>();for(Object v:(Iterable<?>)x)parts.add(json(v));
            return "["+String.join(",",parts)+"]";
        }
        if(x instanceof Number||x instanceof Boolean)return x.toString();
        throw new IllegalArgumentException("unsupported_json_type");
    }
    static List<Double> bounds(Rectangle2D r) {
        return List.of(r.getMinX(),r.getMinY(),r.getMaxX(),r.getMaxY());
    }
    static final class AppearanceReader extends PDFGraphicsStreamEngine {
        final List<Object> glyphs=new ArrayList<>();
        final StringBuilder text=new StringBuilder();
        final Set<String> programs=new LinkedHashSet<>();
        GeneralPath path=new GeneralPath();int pendingClip=-1;
        AppearanceReader(PDPage page){super(page);}
        void read(PDAppearanceStream stream)throws IOException {processChildStream(stream,getPage());}
        @Override protected void showGlyph(Matrix matrix,PDFont font,int code,Vector displacement)throws IOException {
            String unicode=font.toUnicode(code);
            int gid=font instanceof PDType0Font?((PDType0Font)font).codeToGID(code):-1;
            PDStream program=font.getFontDescriptor()==null?null:font.getFontDescriptor().getFontFile2();
            String programHash=null;
            if(program!=null)try{programHash=hash(program.toByteArray());programs.add(programHash);}catch(Exception e){throw new IOException(e);}
            Rectangle2D ink=null;boolean clipped=false,hasGlyph=false;
            if(font instanceof PDVectorFont) {
                PDVectorFont vector=(PDVectorFont)font;hasGlyph=vector.hasGlyph(code);
                AffineTransform transform=matrix.createAffineTransform();
                transform.concatenate(font.getFontMatrix().createAffineTransform());
                Shape shape=transform.createTransformedShape(vector.getNormalizedPath(code));ink=shape.getBounds2D();
                Area outside=new Area(shape);outside.subtract(getGraphicsState().getCurrentClippingPath());clipped=!outside.isEmpty();
            }
            Point2D origin=matrix.transformPoint(0,0);
            glyphs.add(map("code",code,"unicode",unicode,"gid",gid,"hasGlyph",hasGlyph,
                "fontName",font.getName(),"fontSubtype",font.getSubType(),"embedded",font.isEmbedded(),
                "programSha256",programHash,"origin",List.of(origin.getX(),origin.getY()),
                "fontSizePt",getGraphicsState().getTextState().getFontSize(),
                "inkBounds",ink==null?null:bounds(ink),"clipBounds",bounds(getGraphicsState().getCurrentClippingPath().getBounds2D()),
                "inkClipped",clipped));
            if(unicode!=null)text.append(unicode);
        }
        @Override public void appendRectangle(Point2D a,Point2D b,Point2D c,Point2D d){path.moveTo(a.getX(),a.getY());path.lineTo(b.getX(),b.getY());path.lineTo(c.getX(),c.getY());path.lineTo(d.getX(),d.getY());path.closePath();}
        @Override public void drawImage(PDImage image)throws IOException {throw new IOException("image_in_generated_appearance");}
        @Override public void clip(int windingRule){pendingClip=windingRule;}
        @Override public void moveTo(float x,float y){path.moveTo(x,y);}
        @Override public void lineTo(float x,float y){path.lineTo(x,y);}
        @Override public void curveTo(float a,float b,float c,float d,float e,float f){path.curveTo(a,b,c,d,e,f);}
        @Override public Point2D getCurrentPoint(){return path.getCurrentPoint();}
        @Override public void closePath(){path.closePath();}
        @Override public void endPath(){if(pendingClip!=-1){path.setWindingRule(pendingClip);getGraphicsState().intersectClippingPath(path);pendingClip=-1;}path.reset();}
        @Override public void strokePath(){endPath();}
        @Override public void fillPath(int windingRule){endPath();}
        @Override public void fillAndStrokePath(int windingRule){endPath();}
        @Override public void shadingFill(COSName name)throws IOException {throw new IOException("shading_in_generated_appearance");}
    }
    static Map<String,String> readPlan(Path path)throws IOException {
        if(Files.size(path)>65536)throw new IOException("plan_too_large");
        Map<String,String> values=new LinkedHashMap<>();
        for(String line:Files.readAllLines(path,StandardCharsets.UTF_8)) {
            String[] parts=line.split("\t",-1);
            if(parts.length!=2)throw new IOException("invalid_plan_line");
            String key=new String(Base64.getDecoder().decode(parts[0]),StandardCharsets.UTF_8);
            String value=new String(Base64.getDecoder().decode(parts[1]),StandardCharsets.UTF_8);
            if(key.length()>200||value.length()>1000||values.putIfAbsent(key,value)!=null)throw new IOException("plan_limits");
        }
        if(values.isEmpty()||values.size()>16)throw new IOException("plan_field_count");return values;
    }
    static PDAcroForm form(PDDocument doc)throws IOException {
        if(doc.isEncrypted()||!doc.getSignatureDictionaries().isEmpty())throw new IOException("encrypted_or_signed_input");
        PDAcroForm form=doc.getDocumentCatalog().getAcroForm(null);
        if(form==null||form.hasXFA())throw new IOException("native_acroform_required");return form;
    }
    static List<Object> inspect(PDDocument doc,Map<String,String> values)throws Exception {
        PDAcroForm form=form(doc);List<Object> records=new ArrayList<>();
        for(var entry:values.entrySet()) {
            PDField field=form.getField(entry.getKey());
            if(field==null)throw new IOException("missing_saved_field");
            List<Object> appearances=new ArrayList<>();
            for(PDAnnotationWidget widget:field.getWidgets()) {
                PDAppearanceStream stream=widget.getNormalAppearanceStream();
                if(stream==null)throw new IOException("missing_saved_appearance");
                Map<String,Object> appearance=map("bbox",bounds(stream.getBBox().toGeneralPath().getBounds2D()),
                    "widgetRect",bounds(widget.getRectangle().toGeneralPath().getBounds2D()),
                    "appearanceState",widget.getAppearanceState()==null?null:widget.getAppearanceState().getName());
                if(field instanceof PDTextField||field instanceof PDChoice) {
                    if(!stream.getMatrix().equals(new Matrix()))throw new IOException("transformed_appearance_unsupported");
                    AppearanceReader reader=new AppearanceReader(new PDPage(stream.getBBox()));reader.read(stream);
                    appearance.putAll(map("decodedUnicode",reader.text.toString(),"glyphs",reader.glyphs,"fontProgramSha256",reader.programs));
                }
                appearances.add(appearance);
            }
            Object savedValue=field instanceof PDChoice?((PDChoice)field).getValue():field.getValueAsString();
            records.add(map("name",entry.getKey(),"requestedUnicode",entry.getValue(),"savedValue",savedValue,
                "type",field.getFieldType(),"flags",field.getFieldFlags(),"required",field.isRequired(),
                "tooltip",field.getAlternateFieldName(),"appearances",appearances));
        }
        return records;
    }
    public static void main(String[] args)throws Exception {
        if(args.length!=3)throw new IllegalArgumentException("input output base64-tsv-plan required");
        Path input=Path.of(args[0]).toRealPath(),output=Path.of(args[1]).toAbsolutePath().normalize(),plan=Path.of(args[2]).toRealPath();
        if(Files.exists(output)||output.equals(input)||Files.size(input)>33554432)throw new IOException("immutable_new_output_required");
        String sourceHash=hash(Files.readAllBytes(input));Map<String,String> values=readPlan(plan);
        try {
            try(PDDocument doc=Loader.loadPDF(input.toFile())) {
                PDAcroForm form=form(doc);
                if(form.getNeedAppearances())throw new IOException("preexisting_need_appearances_unsupported");
                for(var entry:values.entrySet()) {
                    PDField field=form.getField(entry.getKey());
                    if(!(field instanceof PDTextField||field instanceof PDChoice||field instanceof PDCheckBox)||field.isReadOnly())throw new IOException("unsupported_editable_field");
                    field.setValue(entry.getValue());
                }
                // Validate the generated streams before writing; no viewer fallback is requested.
                inspect(doc,values);
                try(OutputStream out=Files.newOutputStream(output,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){doc.save(out);}
            }
            List<Object> records;
            try(PDDocument saved=Loader.loadPDF(output.toFile())){records=inspect(saved,values);}
            if(!sourceHash.equals(hash(Files.readAllBytes(input))))throw new IOException("source_changed");
            System.out.println(json(map("status","saved","pdfboxVersion",Version.getVersion(),"sourceSha256",sourceHash,
                "outputSha256",hash(Files.readAllBytes(output)),"fields",records,"screenReaderTestPerformed",false)));
        } catch(Exception e) {
            System.out.println(json(map("status","refused_or_failed","pdfboxVersion",Version.getVersion(),"sourceSha256",sourceHash,
                "outputExists",Files.exists(output),"exception",e.getClass().getName(),"reason",e.getMessage())));
            System.exit(2);
        }
    }
}
