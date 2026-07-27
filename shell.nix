# Non-flake dev shell: `nix-shell`.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShellNoCC {
  packages = [ pkgs.nodejs ];
  shellHook = ''
    echo "companion: cd companion && node bin/cli.js help"
    echo "tests:     cd companion && node --test"
  '';
}
