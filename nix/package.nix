{
  lib,
  stdenvNoCC,
  nodejs,
  makeWrapper,
  # The extension talks to a fixed loopback port, so if you move the companion
  # you have to move both halves. Passing `port` here rewrites both.
  port ? 7373,
}:

stdenvNoCC.mkDerivation {
  pname = "accountability-companion";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [ makeWrapper ];

  # No npm dependencies at all — the companion is plain Node standard library,
  # so there is nothing to fetch, lock or vendor.
  dontConfigure = true;
  dontBuild = true;

  postPatch = lib.optionalString (port != 7373) ''
    for f in extension/background.js extension/options.js extension/blocked.js; do
      substituteInPlace "$f" --replace-fail "127.0.0.1:7373" "127.0.0.1:${toString port}"
    done
  '';

  doCheck = true;
  nativeCheckInputs = [ nodejs ];
  checkPhase = ''
    runHook preCheck
    # The suite writes throwaway vaults under $TMPDIR; give it a HOME to
    # resolve, since the sandbox has none.
    export HOME="$TMPDIR"
    (cd companion && node --test)
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/share/accountability-blocker"
    cp -r companion "$out/share/accountability-blocker/companion"
    cp -r extension "$out/share/accountability-blocker/extension"

    makeWrapper ${lib.getExe nodejs} "$out/bin/accountability-companion" \
      --add-flags "$out/share/accountability-blocker/companion/bin/cli.js" \
      --set-default ACCOUNTABILITY_PORT "${toString port}"

    runHook postInstall
  '';

  # The unpacked extension to hand to chrome://extensions lives at
  # "${accountability-companion}/share/accountability-blocker/extension".
  passthru = { inherit port; };

  meta = {
    description = "Local-only site and search-term blocker with a time-locked vault and daily check-in";
    homepage = "https://github.com/0xLysandre/Don-t-Masturbate";
    license = lib.licenses.mit;
    mainProgram = "accountability-companion";
    platforms = lib.platforms.unix;
  };
}
