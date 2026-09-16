import { describe, it, expect } from "vitest";
import { parseDesktopEntry, assertDesktop, DEB_EXEC_RE, APPIMAGE_EXEC_RE } from "../../scripts/verify.js";

const deb = `[Desktop Entry]
Name=Qwen Studio
Exec="/opt/Qwen Studio/qwen-studio" --ozone-platform-hint=auto %U
Terminal=false
Type=Application
Icon=qwen-studio
StartupWMClass=Qwen Studio
Comment=Chat with Qwen
MimeType=x-scheme-handler/qwen;
Categories=Network;Chat;
`;

describe("desktop entry helpers", () => {
  it("parses key/value lines", () => {
    expect(parseDesktopEntry(deb).Exec).toBe('"/opt/Qwen Studio/qwen-studio" --ozone-platform-hint=auto %U');
    expect(parseDesktopEntry(deb).Categories).toBe("Network;Chat;");
  });
  it("accepts a correct deb entry and the AppImage variant", () => {
    expect(() => assertDesktop(parseDesktopEntry(deb), DEB_EXEC_RE)).not.toThrow();
    expect(() =>
      assertDesktop(parseDesktopEntry(deb.replace(/^Exec=.*$/m, "Exec=AppRun --ozone-platform-hint=auto %U")), APPIMAGE_EXEC_RE),
    ).not.toThrow();
  });
  it("rejects a missing ozone flag or mime type", () => {
    expect(() => assertDesktop(parseDesktopEntry(deb.replace(" --ozone-platform-hint=auto", "")), DEB_EXEC_RE)).toThrow(/Exec/);
    expect(() => assertDesktop(parseDesktopEntry(deb.replace("MimeType=x-scheme-handler/qwen;\n", "")), DEB_EXEC_RE)).toThrow(/MimeType/);
  });
  it("rejects wrong Categories or StartupWMClass", () => {
    expect(() => assertDesktop(parseDesktopEntry(deb.replace("Categories=Network;Chat;", "Categories=Network;")), DEB_EXEC_RE)).toThrow(
      /Categories/,
    );
    expect(() =>
      assertDesktop(parseDesktopEntry(deb.replace("StartupWMClass=Qwen Studio", "StartupWMClass=qwen-studio")), DEB_EXEC_RE),
    ).toThrow(/StartupWMClass/);
  });
});
