"""Build-time only: fetch pinned open-source tools and verify exact SHA256."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import urllib.request
import zipfile

BASE = Path("/opt/native-pdf")
BASE.mkdir(parents=True, exist_ok=True)


def download(url, expected):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read(200 * 1024 * 1024 + 1)
    if len(data) > 200 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("Pinned tool checksum mismatch")
    return data


wheel = download("https://files.pythonhosted.org/packages/b1/5b/29e9cab962a533643ae27f56e7a5df8105d90f2dd34cbf314706565272be/opendataloader_pdf-2.5.14-py3-none-any.whl", "71ce513bbd890b4bbcc6e0790e2dfaf61bb5ae0a0869900cd38e6ea853a9727c")
with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
    jar = archive.read("opendataloader_pdf/jar/opendataloader-pdf-cli.jar")
if hashlib.sha256(jar).hexdigest() != "e08c0921fea8a141be96c31096e31251539f23ab4d9eeb88a8cce8f128cb2143":
    raise RuntimeError("Pinned tagger checksum mismatch")
(BASE / "opendataloader-pdf-cli.jar").write_bytes(jar)

installer_zip = download("https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.3-installer.zip", "b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59")
with zipfile.ZipFile(io.BytesIO(installer_zip)) as archive:
    matches = [name for name in archive.namelist() if name.endswith("verapdf-izpack-installer-1.30.3.jar")]
    if len(matches) != 1:
        raise RuntimeError("Pinned validator archive structure mismatch")
    installer = BASE / "installer.jar"
    installer.write_bytes(archive.read(matches[0]))
xml = BASE / "install.xml"
xml.write_text('''<AutomatedInstallation langpack="eng">
<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>/opt/native-pdf/verapdf</installpath></com.izforge.izpack.panels.target.TargetPanel>
<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
<pack index="0" name="veraPDF GUI" selected="false"/>
<pack index="1" name="veraPDF CLI" selected="true"/>
<pack index="2" name="veraPDF Documentation" selected="true"/>
<pack index="3" name="veraPDF Sample Plugins" selected="false"/>
</com.izforge.izpack.panels.packs.PacksPanel>
<com.izforge.izpack.panels.install.InstallPanel id="install"/>
<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>''', encoding="utf-8")
subprocess.run(["/usr/bin/java", "-jar", str(installer), str(xml)], check=True, timeout=120)
installer.unlink()
xml.unlink()
java = ["-Xmx384m", "-Xms32m", "-XX:+UseSerialGC", "-XX:MaxMetaspaceSize=160m", "-XX:CompressedClassSpaceSize=64m", "-Xss512k", "-Djava.awt.headless=true"]
config = {
    "openDataLoader": {"command": "/usr/bin/java", "args": [*java, "-jar", str(BASE / "opendataloader-pdf-cli.jar")], "version": "2.5.14"},
    "veraPdf": {"command": "/usr/bin/java", "args": [*java, "-classpath", "/opt/native-pdf/verapdf/etc:/opt/native-pdf/verapdf/bin/*", "-Dfile.encoding=UTF8", "-Dapp.repo=/opt/native-pdf/verapdf/bin", "-Dapp.home=/opt/native-pdf/verapdf", "-Dbasedir=/opt/native-pdf/verapdf", "--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED", "org.verapdf.apps.GreenfieldCliWrapper"]},
}
(BASE / "toolchain.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
