{
  description = "Accountability & site-blocking companion: a local-only Chrome blocker with a time-locked vault and a daily check-in";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        accountability-companion = pkgs.callPackage ./nix/package.nix { };
        default = accountability-companion;
      });

      apps = forAllSystems (pkgs: rec {
        accountability-companion = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
        default = accountability-companion;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [ pkgs.nodejs ];
          shellHook = ''
            echo "companion: cd companion && node bin/cli.js help"
            echo "tests:     cd companion && node --test"
          '';
        };
      });

      # `nix flake check` runs the full suite via the package's checkPhase.
      checks = forAllSystems (pkgs: {
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });

      nixosModules = rec {
        accountability-companion = import ./nix/nixos-module.nix self;
        default = accountability-companion;
      };

      homeManagerModules = rec {
        accountability-companion = import ./nix/home-manager-module.nix self;
        default = accountability-companion;
      };

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
